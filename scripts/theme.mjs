#!/usr/bin/env node
/**
 * Quantum & Nuclear theme pipeline — a curated-basket momentum leaderboard.
 *
 *   symbols                 → tickers to pull history for (data/theme_quantum_nuclear.json)
 *   run [hist files] [date] → score the basket → outbox/theme-<date>.md
 *
 * Reads per-ETF/ticker hist_*.json (globbed) so the routine pulls each name
 * separately (small/inline) — never one big filed multi-symbol blob.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { scoreTheme, rankTheme } from '../src/strategies/theme/themeScore.js';

const num = (s) => parseFloat(String(s)) || 0;
const list = () => JSON.parse(readFileSync('data/theme_quantum_nuclear.json', 'utf8'));
const signed = (v) => `${v >= 0 ? '+' : ''}${v}`;

const mode = process.argv[2];

if (mode === 'symbols') { console.log(list().map((m) => m.ticker).join(',')); process.exit(0); }

if (mode === 'run') {
  const args = process.argv.slice(3);
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);
  let histFiles = args.filter((a) => a.endsWith('.json'));
  if (!histFiles.length) histFiles = readdirSync('.').filter((f) => /^hist_.*\.json$/.test(f));
  const results = [];
  for (const f of histFiles) { try { results.push(...(JSON.parse(readFileSync(f, 'utf8'))?.data?.results || [])); } catch { /* skip */ } }
  const barsBy = {};
  for (const r of results) barsBy[r.symbol] = (r.bars || []).filter((b) => !b.interpolated).map((b) => ({ c: num(b.close_price), h: num(b.high_price), l: num(b.low_price) }));

  const meta = list();
  const scored = [];
  for (const m of meta) { const bars = barsBy[m.ticker]; if (bars && bars.length >= 15) scored.push(scoreTheme(bars, m)); }

  const out = [`**⚛️ Quantum & Nuclear — ${date}**`, `_the "next frontier" theme · policy tailwind · ${scored.length} names_`];
  const leading = scored.filter((s) => s.state === 'leading' || s.state === 'breakout').length;
  const oversold = scored.filter((s) => s.state === 'oversold').length;
  const avg5 = scored.length ? Math.round((scored.reduce((a, s) => a + s.chg5, 0) / scored.length) * 10) / 10 : 0;
  out.push(`Tone: ${leading} trending up · ${oversold} oversold (accumulate?) · avg ${signed(avg5)}% this week`);

  const setups = rankTheme(scored.filter((s) => ['breakout', 'dip-buy', 'oversold'].includes(s.state))).slice(0, 6);
  if (setups.length) {
    out.push('\n__🎯 on watch (breakouts · dips · oversold)__');
    for (const s of setups) out.push(`${s.tag} **${s.ticker}** $${s.price} — ${s.state} · ${signed(s.chg5)}% wk · ${signed(s.chg21)}% mo · RSI ${s.rsi}`);
  }

  for (const g of [...new Set(meta.map((m) => m.group))]) {
    const names = rankTheme(scored.filter((s) => s.group === g));
    if (!names.length) continue;
    out.push(`\n__${g}__`);
    for (const s of names) out.push(`${s.tag} ${s.ticker} $${s.price} · ${signed(s.chg5)}% wk · ${signed(s.chg21)}% mo · RSI ${s.rsi}`);
  }
  out.push('\n_theme momentum, not individual calls · 🚀 breakout · 🟢 dip-buy · 🔥 leading · ⚪ neutral · 🔴 weak_');

  mkdirSync('outbox', { recursive: true });
  writeFileSync(`outbox/theme-${date}.md`, out.join('\n'));
  console.log(`theme: ${scored.length} scored, ${setups.length} setups`);
  process.exit(0);
}

console.error('usage: theme.mjs symbols | run [hist files] [date]');
process.exit(1);
