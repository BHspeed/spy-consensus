#!/usr/bin/env node
/**
 * Leveraged-ETF swing pipeline (2x/3x buy-the-dip).
 *
 *   symbols                 → ETF tickers to pull history for (data/leveraged_etfs.json)
 *   run <hist.json> [date]  → score → announce NEW oversold-bounce setups →
 *                             outbox/levetf-<date>.md, update the active list
 *
 * hist.json = get_equity_historicals([ETFs], interval=day) raw response.
 * Announces only NEW setups (dedupe vs data/levetf_active.jsonl), like Swings.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { scoreLevSwing, rankLevSwings } from '../src/strategies/levetf/levSwing.js';

const num = (s) => parseFloat(String(s)) || 0;
const list = () => JSON.parse(readFileSync('data/leveraged_etfs.json', 'utf8'));
const ACTIVE = 'data/levetf_active.jsonl';

const mode = process.argv[2];

if (mode === 'symbols') { console.log(list().map((m) => m.etf).join(',')); process.exit(0); }

if (mode === 'run') {
  const hist = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const date = process.argv[4] || new Date().toISOString().slice(0, 10);
  const by = Object.fromEntries(list().map((m) => [m.etf, m]));

  const barsBy = {};
  for (const r of hist?.data?.results || []) {
    barsBy[r.symbol] = (r.bars || []).filter((b) => !b.interpolated)
      .map((b) => ({ c: num(b.close_price), h: num(b.high_price), l: num(b.low_price) }));
  }
  const scored = [];
  for (const [etf, m] of Object.entries(by)) {
    const bars = barsBy[etf];
    if (bars && bars.length >= 15) scored.push(scoreLevSwing(bars, m));
  }
  const ranked = rankLevSwings(scored);

  mkdirSync('data', { recursive: true });
  const active = existsSync(ACTIVE) ? readFileSync(ACTIVE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const openSet = new Set(active.filter((a) => a.status !== 'closed').map((a) => a.etf));
  const fresh = ranked.filter((s) => !openSet.has(s.etf));

  const out = [
    `**⚡ 2x/3x ETF Swings — ${date}**`,
    '_buy the amplified dip at oversold lows · hold days-to-weeks · sell the bounce_',
  ];
  if (fresh.length) {
    for (const s of fresh) {
      out.push(`\n**${s.etf}** (${s.lev}x ${s.parent})  $${s.price}  ·  RSI ${s.rsi}`);
      out.push(`🎯 target +${s.targetPct}% → $${s.target}  (≈ +${s.parentMovePct}% on ${s.parent})   ⛔ stop -${s.stopPct}% → $${s.stop}`);
      out.push(`   oversold + near its low (${s.pullbackPct}% off the high) — buy the dip, hold for the bounce`);
    }
  } else {
    out.push(`\n_No new buy-the-dip setups today (${openSet.size} active). Patience — we only buy the oversold lows._`);
  }
  out.push('\n_leverage cuts both ways — size small and honor the stop._');

  mkdirSync('outbox', { recursive: true });
  writeFileSync(`outbox/levetf-${date}.md`, out.join('\n'));
  for (const s of fresh) {
    appendFileSync(ACTIVE, JSON.stringify({ etf: s.etf, parent: s.parent, lev: s.lev, added: date, entry: s.price, rsi: s.rsi, targetPct: s.targetPct, target: s.target, stop: s.stop, status: 'open' }) + '\n');
  }
  console.log(`levetf: ${fresh.length} new, ${openSet.size} active`);
  process.exit(0);
}

console.error('usage: levetf.mjs symbols | run <hist.json> [date]');
process.exit(1);
