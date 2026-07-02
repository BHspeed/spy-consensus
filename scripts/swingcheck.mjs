#!/usr/bin/env node
/**
 * Weekly swing check + scorecard (used by the scheduled cloud agent).
 *
 *   node scripts/swingcheck.mjs <quotes.json> <hist.json> [date]
 *
 * quotes.json = raw get_equity_quotes response for the active symbols.
 * hist.json   = raw get_equity_historicals (multi-symbol, daily) response.
 *
 * For each OPEN pick in data/swings_active.jsonl: grade it (progress line, or a
 * FINAL verdict when it hits target / stops / hits ~1 month). Writes:
 *   outbox/swings-check-<date>.md   (weekly progress + finals → Swings channel)
 *   outbox/grades-swings-<date>.md  (aggregate scorecard    → private grades channel)
 * and rewrites data/swings_active.jsonl with the updated statuses.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gradePick, summarizeSwings } from '../src/strategies/swings/swingGrade.js';

const num = (s) => parseFloat(String(s).replace(/[,$]/g, '')) || 0;
const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

const ACTIVE = 'data/swings_active.jsonl';
const readActive = () => (existsSync(ACTIVE) ? readFileSync(ACTIVE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// `symbols` mode: print the still-open symbols (comma-sep) for the routine to price.
if (process.argv[2] === 'symbols') {
  console.log(readActive().filter((p) => !p.status || p.status === 'open').map((p) => p.symbol).join(','));
  process.exit(0);
}

const [, , quotesPath, histPath, dateArg] = process.argv;
const today = dateArg || new Date().toISOString().slice(0, 10);
if (!existsSync(ACTIVE)) { console.log('no active swings'); process.exit(0); }
const picks = readActive();

// current price per symbol
const quotes = load(quotesPath);
const lastBy = {};
for (const r of quotes?.data?.results || []) {
  const q = r.quote || {};
  lastBy[q.symbol] = num(q.last_trade_price) || num(q.last_non_reg_trade_price) || num(r.close?.price);
}
// bars per symbol from the multi-symbol historicals
const hist = load(histPath);
const barsBy = {};
for (const r of hist?.data?.results || []) barsBy[r.symbol] = r.bars || [];

function mdFor(p) {
  const bars = (barsBy[p.symbol] || []).filter((b) => !b.interpolated && dayOf(b.begins_at) >= p.added);
  const highs = bars.map((b) => num(b.high_price));
  const lows = bars.map((b) => num(b.low_price));
  const last = lastBy[p.symbol] || (bars.length ? num(bars[bars.length - 1].close_price) : p.entry);
  return { last, highSince: highs.length ? Math.max(...highs) : null, lowSince: lows.length ? Math.min(...lows) : null };
}

const graded = picks.map((p) => (p.status && p.status !== 'open') ? p : gradePick(p, mdFor(p), today));

// ---- weekly check report (→ Swings channel) --------------------------------
const wasOpen = new Set(picks.filter((p) => !p.status || p.status === 'open').map((p) => p.symbol));
const openNow = graded.filter((g) => g.status === 'open');
const closedNow = graded.filter((g) => g.closed && wasOpen.has(g.symbol));
const check = [`**📊 Swings weekly check — ${today}**`];
if (closedNow.length) {
  check.push(`\n__closed this week__`);
  for (const g of closedNow) check.push(`  **${g.symbol}** ${g.verdict}`);
}
if (openNow.length) {
  check.push(`\n__still open (${openNow.length})__`);
  for (const g of openNow) check.push(`  **${g.symbol}** [${g.tier}] ${g.verdict}`);
}
if (!closedNow.length && !openNow.length) check.push('\n(no active picks)');

// ---- aggregate scorecard (→ private grades channel) ------------------------
const s = summarizeSwings(graded);
const card = [`**🎯 Swings scorecard — ${today}**`];
if (s.closed === 0) card.push('\nno closed picks yet — grades build as picks hit their 20-30d window.');
else {
  card.push(`\nclosed ${s.closed} · **hit-rate ${s.hitRate}%** · stopped ${s.stopped} · expired ${s.expired}`);
  card.push(`avg final ${s.avgGain >= 0 ? '+' : ''}${s.avgGain}% · avg peak +${s.avgPeak}%`);
  for (const [t, v] of Object.entries(s.byTier)) card.push(`  ${t}: ${v.n} · ${v.hitRate}% hit · avg peak +${v.avgPeak}%`);
}

mkdirSync('outbox', { recursive: true });
writeFileSync(`outbox/swings-check-${today}.md`, check.join('\n'));
writeFileSync(`outbox/grades-swings-${today}.md`, card.join('\n'));

// rewrite active list with updated grades (finalize closed; refresh open)
const updated = graded.map((g) => {
  const base = { symbol: g.symbol, added: g.added, entry: g.entry, tier: g.tier, targetPct: g.targetPct, targetPrice: g.targetPrice, stopPrice: g.stopPrice, status: g.status };
  if (g.closed) return { ...base, closedOn: today, finalGainPct: g.realizedPct, peakPct: g.mfePct };
  return { ...base, lastGainPct: g.gainPct, peakPct: g.mfePct };
});
writeFileSync(ACTIVE, updated.map((u) => JSON.stringify(u)).join('\n') + '\n');
console.log(`swingcheck: ${openNow.length} open, ${closedNow.length} closed this week, ${s.closed} total closed`);
