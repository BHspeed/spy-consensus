#!/usr/bin/env node
/**
 * Leveraged-ETF swing pipeline (2x/3x buy-the-dip) — scan + self-grade in one pass.
 *
 *   symbols                 → ETF tickers to pull history for (data/leveraged_etfs.json)
 *   run <hist.json> [date]  → grade open picks + announce NEW oversold/floor setups →
 *                             outbox/levetf-<date>.md (setups + closed + R/W/F record),
 *                             update data/levetf_active.jsonl
 *
 * hist.json = get_equity_historicals([ETFs], interval=day, ~6mo) raw response.
 * Announces NEW setups only (dedupe vs still-open picks), like Swings.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { scoreLevSwing, rankLevSwings } from '../src/strategies/levetf/levSwing.js';
import { gradeLevPick, summarizeLev } from '../src/strategies/levetf/levGrade.js';

const num = (s) => parseFloat(String(s)) || 0;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const list = () => JSON.parse(readFileSync('data/leveraged_etfs.json', 'utf8'));
const ACTIVE = 'data/levetf_active.jsonl';

const mode = process.argv[2];

if (mode === 'symbols') { console.log(list().map((m) => m.etf).join(',')); process.exit(0); }

if (mode === 'run') {
  // Accept explicit hist file(s) + a date; if none given, glob per-ETF hist_*.json
  // (the routine pulls each ETF separately so results stay small/inline, never filed).
  const args = process.argv.slice(3);
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);
  let histFiles = args.filter((a) => a.endsWith('.json'));
  if (!histFiles.length) histFiles = readdirSync('.').filter((f) => /^hist_.*\.json$/.test(f));
  const results = [];
  for (const f of histFiles) { try { results.push(...(JSON.parse(readFileSync(f, 'utf8'))?.data?.results || [])); } catch { /* skip bad file */ } }
  const by = Object.fromEntries(list().map((m) => [m.etf, m]));

  const barsBy = {};
  for (const r of results) {
    barsBy[r.symbol] = (r.bars || []).filter((b) => !b.interpolated)
      .map((b) => ({ d: dayOf(b.begins_at), c: num(b.close_price), h: num(b.high_price), l: num(b.low_price) }));
  }

  mkdirSync('data', { recursive: true });
  const all = existsSync(ACTIVE) ? readFileSync(ACTIVE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

  // 1) grade open picks from the ETF's high/low since entry
  const closedNow = [];
  const updated = all.map((p) => {
    if (p.status && p.status !== 'open') return p;
    const bars = (barsBy[p.etf] || []).filter((b) => b.d >= p.added);
    if (!bars.length) return p;
    const md = { high: Math.max(...bars.map((b) => b.h)), low: Math.min(...bars.map((b) => b.l)), last: bars[bars.length - 1].c };
    const g = gradeLevPick(p, md, date);
    if (g.closed) closedNow.push(g);
    return g;
  });
  const openSet = new Set(updated.filter((a) => a.status === 'open').map((a) => a.etf));

  // 2) scan for NEW setups (dedupe vs still-open)
  const scored = [];
  for (const [etf, m] of Object.entries(by)) {
    const bars = barsBy[etf];
    if (bars && bars.length >= 15) scored.push(scoreLevSwing(bars.map((b) => ({ c: b.c, h: b.h, l: b.l })), m));
  }
  const fresh = rankLevSwings(scored).filter((s) => !openSet.has(s.etf));

  // 3) report
  const rec = summarizeLev(updated);
  const out = [
    `**⚡ 2x/3x ETF Swings — ${date}**`,
    '_buy the amplified dip near the floor · hold days-to-weeks · sell the bounce_',
  ];
  if (fresh.length) {
    for (const s of fresh) {
      const floorNote = s.nearFloor
        ? ` · 🧱 **near its floor $${s.floor}** (only ${s.distToFloorPct}% above the multi-month low)`
        : ` · ${s.distToFloorPct}% above its floor $${s.floor}`;
      out.push(`\n**${s.etf}** (${s.lev}x ${s.parent})  $${s.price}  ·  RSI ${s.rsi}${floorNote}`);
      out.push(`🎯 +${s.targetPct}% → $${s.target}  (≈ +${s.parentMovePct}% on ${s.parent})   ⛔ -${s.stopPct}% → $${s.stop}`);
    }
  } else {
    out.push(`\n_No new setups today (${openSet.size} active). We wait for the floor / oversold lows._`);
  }
  if (closedNow.length) {
    out.push('\n__closed this run__');
    for (const g of closedNow) {
      const mk = g.verdict === 'RIGHT' ? '✅' : g.verdict === 'WRONG' ? '❌' : '➖';
      const how = g.verdict === 'RIGHT' ? `hit target $${g.target}` : g.verdict === 'WRONG' ? `hit stop $${g.stop}` : `${g.daysHeld}d, no bounce`;
      out.push(`${mk} ${g.etf} — ${g.verdict}  (entry $${g.entry} → ${how})`);
    }
  }
  out.push(`\n📈 record: ${rec.right}R · ${rec.wrong}W · ${rec.flat}F · ${rec.hitRatePct}% hit-rate (${rec.graded} graded)`);
  out.push('_leverage cuts both ways — size small and honor the stop._');

  // 4) persist: keep graded picks, append fresh
  const finalActive = [...updated];
  for (const s of fresh) {
    finalActive.push({ etf: s.etf, parent: s.parent, lev: s.lev, added: date, entry: s.price, rsi: s.rsi, floor: s.floor, targetPct: s.targetPct, target: s.target, stopPct: s.stopPct, stop: s.stop, status: 'open' });
  }
  writeFileSync(ACTIVE, finalActive.map((a) => JSON.stringify(a)).join('\n') + '\n');
  mkdirSync('outbox', { recursive: true });
  writeFileSync(`outbox/levetf-${date}.md`, out.join('\n'));
  console.log(`levetf: ${fresh.length} new, ${closedNow.length} closed this run, ${rec.graded} graded total`);
  process.exit(0);
}

console.error('usage: levetf.mjs symbols | run <hist.json> [date]');
process.exit(1);
