#!/usr/bin/env node
/**
 * Swing-scan pipeline runner (used by the scheduled cloud agent).
 *
 *   prep <scan.json> [N]           → print top-N tickers (comma-sep) to fetch
 *                                    fundamentals for.
 *   run  <scan.json> <fund.json> [date]
 *                                  → score, detect NEW picks vs
 *                                    data/swings_active.jsonl, write
 *                                    outbox/swings-<date>.md, update the list.
 *
 * scan.json  = raw run_scan / update_scan_filters response.
 * fund.json  = raw get_equity_fundamentals response for the prep tickers.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { scoreSwing, rankSwings } from '../src/strategies/swings/swingScore.js';

const num = (s) => parseFloat(String(s).replace(/[,$]/g, '')) || 0;

function parseScan(path) {
  const rows = JSON.parse(readFileSync(path, 'utf8')).data.result.results;
  return rows.map((r) => {
    const x = r.columns || {};
    return {
      ticker: r.ticker, name: (x.Name || '').slice(0, 24),
      last: num(x.Last), mc: num(x['Market cap']), rsi: num(x.RSI),
      adx: num(x['Average directional index (14)']), relv: num(x['Relative volume']),
      chg: num(x['% Change']),
    };
  }).filter((s) => s.last >= 5 && s.last <= 1500);
}

function firstPass(cands) {
  const rsiFit = (r) => Math.max(0, 1 - Math.abs(r - 63) / 12);
  const nrm = (v, cap) => Math.min(1, v / cap);
  cands.forEach((s) => { s.pp = 0.35 * nrm(s.relv, 3) + 0.30 * nrm(s.adx, 45) + 0.20 * rsiFit(s.rsi) + 0.15 * nrm(Math.abs(s.chg), 5); });
  return [...cands].sort((a, b) => b.pp - a.pp);
}

const mode = process.argv[2];

if (mode === 'prep') {
  const N = +(process.argv[4] || 15);
  console.log(firstPass(parseScan(process.argv[3])).slice(0, N).map((s) => s.ticker).join(','));
  process.exit(0);
}

if (mode === 'run') {
  const scan = parseScan(process.argv[3]);
  const byTicker = Object.fromEntries(scan.map((s) => [s.ticker, s]));
  const fund = JSON.parse(readFileSync(process.argv[4], 'utf8')).data.results;
  const dateStr = process.argv[5] || new Date().toISOString().slice(0, 10);

  const cands = fund.map((f) => {
    const sc = byTicker[f.symbol] || {};
    return {
      symbol: f.symbol, name: sc.name || (f.description || '').split('.')[0].slice(0, 24),
      price: sc.last || num(f.high), marketCap: num(f.market_cap),
      high52: num(f.high_52_weeks), low52: num(f.low_52_weeks),
    };
  }).filter((c) => c.price > 0 && c.high52 > 0 && c.low52 > 0);
  const ranked = rankSwings(cands.map(scoreSwing));

  mkdirSync('data', { recursive: true });
  mkdirSync('outbox', { recursive: true });
  const ACTIVE = 'data/swings_active.jsonl';
  const active = existsSync(ACTIVE) ? readFileSync(ACTIVE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const openSet = new Set(active.filter((a) => a.status !== 'closed').map((a) => a.symbol));

  const fresh = ranked.filter((s) => !openSet.has(s.symbol));
  const out = [];
  if (fresh.length) {
    out.push(`**🆕 NEW SWING PICKS — ${dateStr}**  (20-30 day holds · shares)`);
    for (const s of fresh) {
      out.push(`\n**${s.symbol}** $${s.price}  [${s.tier}]   🎯 +${s.targetPct}% → $${s.targetPrice}    ⛔ -${s.stopPct}% → $${s.stopPrice}    R:R ${s.rr}`);
      out.push(`   ${s.why}`);
    }
    out.push(`\n_target is a projection from the stock's own range, not a promise — the scorecard grades the real hit-rate._`);
  } else {
    out.push(`**Swings — ${dateStr}:** no new picks today (${openSet.size} still active).`);
  }
  writeFileSync(`outbox/swings-${dateStr}.md`, out.join('\n'));
  for (const s of fresh) {
    appendFileSync(ACTIVE, JSON.stringify({ symbol: s.symbol, added: dateStr, entry: s.price, tier: s.tier, targetPct: s.targetPct, targetPrice: s.targetPrice, stopPrice: s.stopPrice, status: 'open' }) + '\n');
  }
  console.log(`swings: ${fresh.length} new, ${openSet.size} already active`);
  process.exit(0);
}

console.error('usage: swings.mjs prep <scan.json> [N]  |  run <scan.json> <fund.json> [date]');
process.exit(1);
