#!/usr/bin/env node
/**
 * Weekly value-flip grading runner (self-scores the channel's own callouts).
 *
 *   symbols                  → underlyings of open picks (to pull high/low for)
 *   run <hist.json> [date]   → grade the day's callouts from the underlying's
 *                              high/low → outbox/weekly-grade-<date>.md (R/W/F
 *                              per pick + running record), update the trace log.
 *
 * hist.json = get_equity_historicals([underlyings], interval=hour|day, today).
 * Posts to the SAME Weekly Options channel (weekly-grade-* matches weekly-*).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gradeWeeklyPick, summarizeWeeklies } from '../src/strategies/weeklies/weeklyGrade.js';

const num = (s) => parseFloat(String(s).replace(/[,$]/g, '')) || 0;
const TRACE = 'data/weekly_trace.jsonl';
const read = () => (existsSync(TRACE) ? readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const mode = process.argv[2];

if (mode === 'symbols') {
  console.log([...new Set(read().filter((p) => p.status === 'open').map((p) => p.symbol))].join(','));
  process.exit(0);
}

if (mode === 'run') {
  const hist = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const date = process.argv[4] || new Date().toISOString().slice(0, 10);

  const hl = {};
  for (const r of hist?.data?.results || []) {
    const bars = (r.bars || []).filter((b) => !b.interpolated);
    if (bars.length) hl[r.symbol] = { high: Math.max(...bars.map((b) => num(b.high_price))), low: Math.min(...bars.map((b) => num(b.low_price))) };
  }

  const recs = read();
  let gradedToday = 0;
  const updated = recs.map((p) => {
    if (p.status === 'open' && p.date === date && hl[p.symbol]) { gradedToday++; return gradeWeeklyPick(p, hl[p.symbol]); }
    return p;
  });
  writeFileSync(TRACE, updated.map((u) => JSON.stringify(u)).join('\n') + '\n');

  const todays = updated.filter((p) => p.date === date && p.status === 'graded');
  const s = summarizeWeeklies(updated);
  const out = [`**⚡ Weekly Value-Flip — grade ${date}**`];
  if (todays.length) {
    for (const p of todays) {
      const mk = p.verdict === 'RIGHT' ? '✅' : p.verdict === 'WRONG' ? '❌' : '➖';
      const arrow = p.type === 'call' ? '≥' : '≤';
      out.push(`${mk} ${p.contract} — ${p.verdict}  (needed ${p.symbol} ${arrow} $${p.flipUnderlying}; day ${p.low}–${p.high})`);
    }
  } else out.push('_no callouts to grade today._');
  out.push(`\n📈 record: ${s.right}R · ${s.wrong}W · ${s.flat}F · ${s.hitRatePct}% flip-rate (${s.graded} graded)`);

  mkdirSync('outbox', { recursive: true });
  writeFileSync(`outbox/weekly-grade-${date}.md`, out.join('\n'));
  console.log(`weeklygrade: graded ${gradedToday} today, ${s.graded} total`);
  process.exit(0);
}

console.error('usage: weeklygrade.mjs symbols | run <hist.json> [date]');
process.exit(1);
