#!/usr/bin/env node
/**
 * Forward-trace runner.
 *
 *   Evaluate a day vs the morning call (and optionally log it):
 *     node scripts/trace.mjs eval --date=YYYY-MM-DD --dir=UP --conf=69 \
 *        --open=741.1 --midday=743 --high=745 --low=740 --close=744 [--log]
 *
 *   Aggregate the learning scorecard over the trace log:
 *     node scripts/trace.mjs summary [logs/spy_trace.jsonl]
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { evaluateDay, summarizeTraces } from '../src/consensus/forwardTrace.js';

const cmd = process.argv[2];
const arg = (k, d) => { const h = process.argv.find(a => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const num = (k) => { const v = arg(k); return v == null ? null : +v; };
const L = (s = '') => console.log(s);
const TRACE_LOG = 'logs/spy_trace.jsonl';

if (cmd === 'eval') {
  const day = evaluateDay({
    date: arg('date'), predictedDir: (arg('dir') || 'SIDEWAYS').toUpperCase(), confidence: num('conf') || 0,
    open: num('open'), midday: num('midday'), high: num('high'), low: num('low'), close: num('close'),
  });
  L('\n========  FORWARD TRACE — ' + (day.date || 'today') + '  ========');
  L(`  called:  ${day.predictedDir} ${day.confidence}%   open ${day.open}`);
  L(`  path:    open → midday ${day.midday ?? '—'} (${day.middayMovePct ?? '—'}%) → close ${day.close} (${day.closeMovePct >= 0 ? '+' : ''}${day.closeMovePct}%)`);
  L(`  range:   high ${day.high} / low ${day.low}`);
  if (day.verdict !== 'NO-TRADE') {
    L(`  peak in predicted dir:  ${day.mfePct >= 0 ? '+' : ''}${day.mfePct}%   worst: ${day.maePct}%`);
    L(`  VERDICT: ${day.verdict}   ·   scalpable pop: ${day.scalpablePop ? 'YES ✓' : 'no'}`);
  } else {
    L(`  VERDICT: NO-TRADE (sideways)`);
  }
  L('  ' + day.note);
  if (process.argv.includes('--log')) {
    const logfile = arg('logfile') || TRACE_LOG;
    mkdirSync(logfile.includes('/') ? logfile.replace(/\/[^/]*$/, '') : '.', { recursive: true });
    appendFileSync(logfile, JSON.stringify({ type: 'trace', ...day }) + '\n');
    L(`  (logged → ${logfile})`);
  }
  L('==================================================\n');
} else if (cmd === 'summary') {
  const path = process.argv[3] || TRACE_LOG;
  let recs = [];
  try { recs = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { console.error(`no trace log at ${path}`); process.exit(1); }
  const s = summarizeTraces(recs);
  L('\n========  FORWARD-TRACE SCORECARD  ========');
  L(`  scored days: ${s.days}`);
  L(`  closed RIGHT: ${s.closedRightPct}%  (${s.right}R / ${s.wrong}W / ${s.flat} flat)`);
  L(`  SCALPABLE pop in predicted dir: ${s.scalpablePct}%   <-- what matters for your style`);
  L(`  avg peak (MFE) ${s.avgMfe}%   ·   avg worst (MAE) ${s.avgMae}%`);
  L('  by confidence:');
  for (const [b, v] of Object.entries(s.byConfidence)) {
    if (v.n) L(`    ${b}%: ${v.n} days · ${v.scalpablePct}% scalpable · ${v.closedRightPct}% closed-right · avg peak ${v.avgMfe}%`);
  }
  L('===========================================\n');
} else if (cmd === 'record') {
  // Compact one-liner for the SPY channel EOD trace (public running record).
  const path = process.argv[3] || TRACE_LOG;
  let recs = [];
  try { recs = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { process.exit(0); }
  const s = summarizeTraces(recs);
  L(`\n📈 SPY record: ${s.right}R · ${s.wrong}W · ${s.flat}F · ${s.closedRightPct}% hit-rate · ${s.scalpablePct}% scalpable (${s.days} graded)`);
} else {
  console.error('usage: trace.mjs eval --dir=UP --conf=69 --open=.. --high=.. --low=.. --close=.. [--midday=..] [--log]');
  console.error('       trace.mjs summary [logs/spy_trace.jsonl]  |  trace.mjs record [logs/spy_trace.jsonl]');
  process.exit(1);
}
