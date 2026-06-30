#!/usr/bin/env node
/**
 * Summary view over the run log.  node scripts/logsummary.mjs [path]
 * Default path: logs/spy_runs.jsonl
 */
import { readFileSync } from 'node:fs';
import { summarize } from '../src/consensus/logStats.js';

const path = process.argv[2] || 'logs/spy_runs.jsonl';
let lines;
try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean); }
catch { console.error(`no log at ${path} — run \`node scripts/run.mjs --log\` a few times first.`); process.exit(1); }

const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const s = summarize(records);
const L = (x = '') => console.log(x);
const day = (t) => (t ? t.slice(0, 10) : '—');

L('\n==============  SPY RUN LOG — SUMMARY  ==============');
L(`  ${day(s.period.from)} → ${day(s.period.to)}    (${s.runs.total} runs)`);
L('');
L('  RUNS');
L(`    ideas ${s.runs.ideas}   ·   stand-aside ${s.runs.standAside}   ·   no-chain ${s.runs.noChain}`);
L(`    direction:  UP ${s.runs.byDir.UP}  ·  DOWN ${s.runs.byDir.DOWN}  ·  SIDEWAYS ${s.runs.byDir.SIDEWAYS}`);
L(`    avg confidence (ideas): ${s.runs.avgConfidenceIdeas}%`);
L('');
L('  CONSENSUS DIRECTION  (proxy: move to the next logged run)');
if (s.direction.comparable === 0) {
  L('    not enough runs yet to judge direction (need 2+ with a spot).');
} else {
  L(`    right ${s.direction.right}  ·  wrong ${s.direction.wrong}  ·  flat ${s.direction.flat}   →  hit-rate ${s.direction.hitRatePct}%`);
  L(`    avg confidence when right ${s.direction.avgConfWhenRight}%  vs  wrong ${s.direction.avgConfWhenWrong}%`);
}
L('');
L('  TRADES');
if (s.trades.closed === 0) {
  L(`    no closed trades yet${s.trades.open ? ` (${s.trades.open} open)` : ''} — take some and I'll record the fills.`);
} else {
  L(`    closed ${s.trades.closed}  ·  win rate ${s.trades.winRatePct}%  (${s.trades.wins}W / ${s.trades.losses}L)`);
  L(`    total P&L $${s.trades.totalPnl}   ·   avg $${s.trades.avgPnl}/trade`);
  for (const [k, v] of Object.entries(s.trades.byStructure)) {
    L(`      ${k.padEnd(7)} ${v.n} trades · ${v.winRatePct}% win · avg $${v.avgPnl}`);
  }
  if (s.trades.best) L(`    best  +$${s.trades.best.pnl}  (${s.trades.best.structure})`);
  if (s.trades.worst) L(`    worst $${s.trades.worst.pnl}  (${s.trades.worst.structure})`);
}
L('====================================================\n');
