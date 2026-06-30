#!/usr/bin/env node
/**
 * SPY direction-consensus runner.
 *
 * Reads an OHLCV JSON bundle and prints the consensus verdict. The bundle shape:
 *   { daily:[bars], hourly:[bars], intraday:[bars], priorDay:{high,low,close}, lastPrice:num }
 * where each bar is { time, open, high, low, close, volume }.
 *
 * Usage:  node scripts/consensus.mjs <bundle.json> [--proposed=short]
 *
 * Data can come from anywhere (Robinhood historicals, TradingView export, etc.).
 * The engine itself is pure and lives in src/consensus/.
 */
import { readFileSync } from 'node:fs';
import { buildVerdict } from '../src/consensus/engine.js';

const file = process.argv[2];
const proposedArg = (process.argv.find(a => a.startsWith('--proposed=')) || '').split('=')[1];
if (!file) { console.error('usage: node scripts/consensus.mjs <bundle.json> [--proposed=short]'); process.exit(1); }

const data = JSON.parse(readFileSync(file, 'utf8'));
const v = buildVerdict(data);

const bar = (score) => {
  const n = Math.round(Math.abs(score) / 5);
  const fill = '█'.repeat(n).padEnd(20, '·');
  return score >= 0 ? `        |${fill}` : `${fill.split('').reverse().join('')}|`;
};

console.log('\n══════════════  SPY DIRECTION CONSENSUS  ══════════════');
console.log(`  Bias:        ${v.bias}        (side: ${v.side})`);
console.log(`  Score:       ${v.score >= 0 ? '+' : ''}${v.score}   [-100 down … +100 up]`);
console.log(`               ${bar(v.score)}`);
console.log(`  Confidence:  ${v.confidence}%`);
console.log(`  Daily trend: ${v.dominantTrend}   |   ADX ${v.adx}   |   last ${v.lastPrice}`);
console.log(`  Exp. move:   ±${v.expectedMove.dailyAtr} (${v.expectedMove.atrPct}% ATR/day)   |   ${v.overextensionAtr} ATR from 20-EMA`);
console.log('  ───────────────  signals  ───────────────');
for (const s of v.signals.sort((a, b) => b.weight - a.weight)) {
  const dirc = s.score > 0.05 ? '↑' : s.score < -0.05 ? '↓' : '·';
  console.log(`    ${dirc} ${String(s.score).padStart(6)}  (w${s.weight})  ${s.label}`);
}
if (v.warnings.length) {
  console.log('  ───────────────  warnings  ──────────────');
  for (const w of v.warnings) console.log(`    ⚠  ${w}`);
}
if (proposedArg) {
  const c = v.counterTrendCheck(proposedArg);
  console.log('  ───────────────  trade check  ───────────');
  console.log(`    proposed "${proposedArg}":  ${c ? '⛔ ' + c : '✓ aligned with consensus'}`);
}
console.log('═══════════════════════════════════════════════════════\n');
