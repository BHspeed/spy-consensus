#!/usr/bin/env node
/**
 * Weekly value-flip options pipeline (used by the scheduled cloud agent).
 *
 *   dirs <daily.json>                      → per-underlying direction + spot +
 *                                            expected move + which strikes to pull
 *   run  <daily.json> <opts.json> [date]   → select value-flip weeklies →
 *                                            outbox/weekly-<date>.md
 *
 * daily.json = get_equity_historicals([underlyings], interval=day) raw response
 * opts.json  = a JSON array the agent assembled from the option chain, each item:
 *   { symbol, type:'call'|'put', strike, expiry, dte, mark, bid, ask, delta,
 *     gamma, open_interest, volume }
 *
 * Direction here is a light momentum lean (close vs EMA20 + 5-day slope); the
 * value flip works on small moves, and the full SPY consensus posts separately.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { selectWeeklies } from '../src/strategies/weeklies/weeklyOption.js';

const num = (s) => parseFloat(String(s).replace(/[,$]/g, '')) || 0;
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const barsFor = (daily) => {
  const out = {};
  for (const r of daily?.data?.results || []) {
    out[r.symbol] = (r.bars || []).filter((b) => !b.interpolated)
      .map((b) => ({ c: num(b.close_price), h: num(b.high_price), l: num(b.low_price) }));
  }
  return out;
};
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; for (const x of arr.slice(1)) e = x * k + e * (1 - k); return e; };
const atrPct = (bars) => {
  const n = Math.min(14, bars.length - 1);
  if (n < 2) return 0.6;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    s += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  }
  return (s / n) / bars[bars.length - 1].c * 100;
};
const readDir = (bars) => {
  const c = bars.map((b) => b.c);
  const spot = c[c.length - 1];
  const e20 = ema(c.slice(-40), 20);
  const mom5 = c.length > 5 ? ((spot - c[c.length - 6]) / c[c.length - 6]) * 100 : 0;
  const dir = (spot > e20 && mom5 >= 0) ? 'UP' : (spot < e20 && mom5 <= 0) ? 'DOWN' : (mom5 >= 0 ? 'UP' : 'DOWN');
  const move = Math.max(0.3, Math.min(2.5, atrPct(bars) * 0.7));
  return { spot, dir, expectedMovePct: Math.round(move * 100) / 100 };
};

const mode = process.argv[2];

if (mode === 'dirs') {
  const bars = barsFor(load(process.argv[3]));
  for (const [sym, b] of Object.entries(bars)) {
    if (b.length < 6) continue;
    const { spot, dir, expectedMovePct } = readDir(b);
    const atm = Math.round(spot);
    const side = dir === 'DOWN' ? 'PUTS' : 'CALLS';
    const strikes = dir === 'DOWN' ? [atm + 1, atm, atm - 1, atm - 2, atm - 3] : [atm - 1, atm, atm + 1, atm + 2, atm + 3];
    console.log(`${sym} ${dir} spot ${spot.toFixed(2)} move ${expectedMovePct}% -> pull ${side} strikes ${strikes.join(',')}`);
  }
  process.exit(0);
}

if (mode === 'run') {
  const bars = barsFor(load(process.argv[3]));
  const opts = load(process.argv[4]);
  const date = process.argv[5] || new Date().toISOString().slice(0, 10);
  const bySym = {};
  for (const o of opts) (bySym[o.symbol] = bySym[o.symbol] || []).push(o);

  const picks = [];
  for (const [sym, b] of Object.entries(bars)) {
    if (!bySym[sym] || b.length < 6) continue;
    const { spot, dir, expectedMovePct } = readDir(b);
    const sel = selectWeeklies(bySym[sym], { spot, expectedMovePct, dir }, 1);
    if (sel[0]) picks.push({ ...sel[0], dir, expectedMovePct });
  }
  picks.sort((a, b) => b.score - a.score);

  const out = [
    `**⚡ Weekly Value-Flip Plays — ${date}**`,
    "_buy one, scalp the premium flip 10%+ — don't wait to be right on strike_",
  ];
  if (!picks.length) out.push('\n_No clean value-flip setups today (thin/wide markets or no clear direction)._');
  for (const p of picks.slice(0, 4)) {
    out.push(`\n**${p.contract}**  @ $${p.mark}  (${p.dir}, Δ${p.delta}, ${p.moneyness > 0 ? '+' : ''}${p.moneyness}%)`);
    out.push(`➡️ bank +10% $${p.plan.arm} · target +20% $${p.plan.take} · stop $${p.plan.stop}`);
    out.push(`   ~${p.valueFlipPct}% flip if ${p.symbol} moves ${p.expectedMovePct}% your way`);
  }
  out.push('\n_value-flip levels — take the 10%+ when it comes; this is separate from the SPY spread system._');

  mkdirSync('outbox', { recursive: true });
  writeFileSync(`outbox/weekly-${date}.md`, out.join('\n'));
  console.log(`weeklies: ${picks.length} picks`);
  process.exit(0);
}

console.error('usage: weeklies.mjs dirs <daily.json> | run <daily.json> <opts.json> [date]');
process.exit(1);
