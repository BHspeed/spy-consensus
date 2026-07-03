#!/usr/bin/env node
/**
 * Earnings/News pipeline (used by the scheduled cloud agent).
 *
 *   symbols <reported.json>                        → tickers to pull prices for
 *   run <reported.json> <hist.json> <upcoming.json> [date]
 *                                                  → analyze → outbox/news-<date>.md
 *
 * reported.json = get_earnings_calendar(days=-2, high_market_cap) raw response
 * upcoming.json = get_earnings_calendar(days=6,  high_market_cap) raw response
 * hist.json     = get_equity_historicals(reporters, daily) raw response
 *
 * Covers the whole high-market-cap tape, ranked by |EPS surprise|; active swing
 * picks are always included and labeled. news-* routes to the News channel.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { analyzeEarnings } from '../src/strategies/earnings/earningsAnalyze.js';

const SEEN = 'data/earnings_seen.jsonl';

const CAP = 10;
const num = (s) => parseFloat(String(s).replace(/[,$]/g, '')) || 0;
const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

const swingSymbols = () => {
  try {
    return new Set(readFileSync('data/swings_active.jsonl', 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((p) => !p.status || p.status === 'open').map((p) => p.symbol));
  } catch { return new Set(); }
};
const reporters = (cal) => (cal?.data?.results || []).filter((e) => e.eps && e.eps.actual != null && e.eps.actual !== '');
const surpriseOf = (e) => { const est = num(e.eps.estimate); return est !== 0 ? Math.abs((num(e.eps.actual) - est) / Math.abs(est)) : 0; };

const mode = process.argv[2];

if (mode === 'symbols') {
  const sw = swingSymbols();
  const ranked = reporters(load(process.argv[3]))
    .sort((a, b) => (sw.has(b.symbol) ? 1 : 0) - (sw.has(a.symbol) ? 1 : 0) || surpriseOf(b) - surpriseOf(a));
  console.log([...new Set(ranked.map((e) => e.symbol))].slice(0, CAP).join(','));
  process.exit(0);
}

if (mode === 'run') {
  const cal = load(process.argv[3]);
  const hist = load(process.argv[4]);
  const upcoming = load(process.argv[5]);
  const today = process.argv[6] || new Date().toISOString().slice(0, 10);
  const sw = swingSymbols();

  const barsBy = {};
  for (const r of hist?.data?.results || []) {
    barsBy[r.symbol] = (r.bars || []).filter((b) => !b.interpolated).sort((a, b) => (a.begins_at < b.begins_at ? -1 : 1));
  }
  const reaction = (e) => {
    const bars = barsBy[e.symbol];
    if (!bars || !bars.length) return null;
    const idx = bars.findIndex((b) => dayOf(b.begins_at) === e.report.date);
    if (idx < 0) return null;
    let before, after;
    if (e.report.timing === 'am') { if (idx < 1) return null; before = num(bars[idx - 1].close_price); after = num(bars[idx].close_price); }
    else { if (idx + 1 >= bars.length) return null; before = num(bars[idx].close_price); after = num(bars[idx + 1].close_price); }
    return before ? ((after - before) / before) * 100 : null;
  };

  const seen = new Set();
  try { readFileSync(SEEN, 'utf8').split('\n').filter(Boolean).forEach((l) => seen.add(JSON.parse(l).key)); } catch { /* first run */ }

  const analyzed = reporters(cal).map((e) => {
    const a = analyzeEarnings({ symbol: e.symbol, epsEstimate: e.eps.estimate, epsActual: e.eps.actual, quarter: e.quarter, year: e.year, priceReactionPct: reaction(e) });
    a.isSwing = sw.has(e.symbol);
    a.reportDate = e.report.date;
    a.key = `${e.symbol}|${e.report.date}`;
    return a;
  }).sort((a, b) => (b.isSwing ? 1 : 0) - (a.isSwing ? 1 : 0) || Math.abs(b.surprisePct || 0) - Math.abs(a.surprisePct || 0));
  // Post once, when the reaction has resolved (AMC reporters land the next run).
  const top = analyzed.filter((a) => a.priceReactionPct != null && !seen.has(a.key)).slice(0, CAP);

  const out = [`**📰 Earnings & News — ${today}**`];
  const emit = (a) => { out.push(`\n**${a.headline}**${a.isSwing ? '  _(your swing)_' : ''}`); out.push(`   ${a.note}`); };
  const isBull = (a) => ['bullish', 'bullish divergence', 'lean bullish'].includes(a.verdict);
  const isBear = (a) => ['bearish', 'bearish divergence', 'lean bearish'].includes(a.verdict);
  const bull = top.filter(isBull);
  const bear = top.filter(isBear);
  const mixed = top.filter((a) => !isBull(a) && !isBear(a));
  if (bull.length) { out.push('\n__📈 bullish__'); bull.forEach(emit); }
  if (bear.length) { out.push('\n__📉 bearish__'); bear.forEach(emit); }
  if (mixed.length) { out.push('\n__➖ mixed / muted__'); mixed.forEach(emit); }
  if (!top.length) out.push('\n_No new large-cap earnings with confirmed reactions today._');

  const upSwing = (upcoming?.data?.results || []).filter((e) => sw.has(e.symbol) && (!e.eps || e.eps.actual == null || e.eps.actual === ''));
  if (upSwing.length) {
    out.push('\n__⚠️ your swing picks reporting soon__');
    for (const e of upSwing) out.push(`   ${e.symbol} — ${e.report.date} (${e.report.timing}) · est EPS ${e.eps?.estimate ?? '—'}`);
  }
  out.push('\n_critical read = EPS surprise × price reaction; divergences (beat-but-sold-off, miss-but-rallied) are the real tell._');

  mkdirSync('outbox', { recursive: true });
  mkdirSync('data', { recursive: true });
  writeFileSync(`outbox/news-${today}.md`, out.join('\n'));
  for (const a of top) appendFileSync(SEEN, JSON.stringify({ key: a.key, on: today }) + '\n'); // dedupe future runs
  console.log(`earnings: ${top.length} posted, ${upSwing.length} swing picks upcoming`);
  process.exit(0);
}

console.error('usage: earnings.mjs symbols <reported.json> | run <reported.json> <hist.json> <upcoming.json> [date]');
process.exit(1);
