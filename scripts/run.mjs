#!/usr/bin/env node
/**
 * "run it" — the whole pipeline in one shot.
 *
 *   OHLCV → consensus (direction + confidence + counter-trend gate)
 *         → if tradeable: option chain → ranked, confidence-scored choices
 *         → pick the value-flip vehicle + defined-risk alternative
 *         → concrete entry + value-flip exit plan + sizing.
 *
 * Offline demo uses scripts/_data.mjs. A live run is identical except the bars
 * and option quotes come from a freshly-pulled Robinhood bundle (see RUNBOOK.md);
 * pass one with:  node scripts/run.mjs <bundle.json>
 */
import { readFileSync } from 'node:fs';
import { buildVerdict } from '../src/consensus/engine.js';
import { selectTrades, fromRobinhood } from '../src/consensus/optionSelect.js';
import { DEFAULT_CONFIG } from '../src/consensus/valueFlip.js';
import * as sample from './_data.mjs';

// ---- assemble inputs (bundle file overrides the offline sample) ------------
let daily, hourly, intraday, priorDay, lastPrice, expiry, contracts, asOf;
const file = process.argv[2];
if (file) {
  const b = JSON.parse(readFileSync(file, 'utf8'));
  ({ priorDay, lastPrice, expiry, asOf } = b);
  daily = b.daily; hourly = b.hourly || []; intraday = b.intraday || [];
  contracts = (b.optionQuotes || []).map(q => fromRobinhood(q.strike, q.type || 'call', q));
} else {
  daily = sample.toBars(sample.dailyRows);
  hourly = sample.toBars(sample.hourlyRows);
  intraday = hourly.slice(-6);
  priorDay = sample.priorDay; lastPrice = sample.lastPrice; expiry = sample.optionExpiry;
  asOf = '2026-06-29 close (offline sample)';
  contracts = sample.optionQuotes; // selectTrades is given normalized below
}

const verdict = buildVerdict({ daily, hourly, intraday, priorDay, lastPrice });

// normalize sample quotes (bundle path already normalized above)
if (!file) contracts = sample.optionQuotes.map(q => fromRobinhood(q.strike, 'call', q));
// flip to puts if the verdict says down
if (verdict.side === 'LONG_PUTS' && !file) {
  contracts = []; // sample only has calls; live bundle would carry the put side
}

const L = (s = '') => console.log(s);
const gate = verdict.counterTrendCheck(verdict.side === 'LONG_PUTS' ? 'short' : 'long');

L('\n╔══════════════════  SPY — RUN IT  ══════════════════╗');
L(`  as of ${asOf}   spot ~${verdict.lastPrice}`);
L('  ──────────────────  1) CONSENSUS  ──────────────────');
L(`  ${verdict.bias}  (${verdict.side})   score ${verdict.score >= 0 ? '+' : ''}${verdict.score}   confidence ${verdict.confidence}%`);
L(`  daily trend ${verdict.dominantTrend} | ADX ${verdict.adx} | exp move ±${verdict.expectedMove.dailyAtr} (${verdict.expectedMove.atrPct}%/day)`);
for (const w of verdict.warnings) L(`  ⚠ ${w}`);

// ---- decision gate ---------------------------------------------------------
if (verdict.bias === 'NEUTRAL' || verdict.confidence < 45) {
  L('  ──────────────────  2) DECISION  ────────────────────');
  L('  ▶ STAND ASIDE — no trade. Conviction too low / signals conflict.');
  L('    (This is a result, not a failure. Sitting out is a position.)');
  L('╚═════════════════════════════════════════════════════╝\n');
  process.exit(0);
}

const sel = selectTrades(verdict, contracts, { maxCandidates: 6 });
if (!contracts.length) {
  L('  ──────────────────  2) OPTIONS  ─────────────────────');
  L(`  (no ${verdict.side === 'LONG_PUTS' ? 'put' : 'call'} quotes loaded — pull the ${expiry} chain to populate)`);
  L('╚═════════════════════════════════════════════════════╝\n');
  process.exit(0);
}

const longs = sel.candidates.filter(c => c.kind === 'long_single');
const spreads = sel.candidates.filter(c => c.kind === 'debit_vertical');
const primary = longs[0] || sel.candidates[0];      // value-flip vehicle
const alt = spreads[0];                              // defined-risk alternative

// ---- value-flip exit plan for the primary ---------------------------------
const entryMark = primary.cost / 100;
const cfg = DEFAULT_CONFIG;
const tpFloor = (entryMark * (1 + cfg.minProfitPct / 100)).toFixed(2);
const hardStop = (entryMark * (1 - cfg.stopPct / 100)).toFixed(2);
const hardTake = (entryMark * (1 + cfg.hardTakePct / 100)).toFixed(2);

L(`  ────────────  2) OPTIONS (${expiry}, ranked)  ────────────`);
sel.candidates.forEach((t, i) => {
  const tag = t === primary ? ' ◀ value-flip pick' : t === alt ? ' ◀ defined-risk alt' : '';
  const pl = t.kind === 'debit_vertical' ? `$${t.cost}→$${t.maxProfit} R/R ${t.rr}` : `$${t.cost} uncapped`;
  L(`   ${String(t.confidence).padStart(2)}%  ${t.structure.padEnd(15)} ${pl.padEnd(20)} BE ${t.breakeven}${tag}`);
});

L('  ──────────────────  3) THE IDEA  ────────────────────');
L(`  ▶ ${primary.structure}  @ ~$${primary.cost}/contract   confidence ${primary.confidence}%`);
L(`    breakeven ${primary.breakeven} · Δ${primary.delta} · sized for value-flip exit (not expiry)`);
L(`    EXIT (value flips, not strikes):`);
L(`      • take profit once up ≥${cfg.minProfitPct}% and it gives back ${cfg.trailPct}% of peak gain`);
L(`        → first arms around mark $${tpFloor} (+${cfg.minProfitPct}%)`);
L(`      • hard-take at mark $${hardTake} (+${cfg.hardTakePct}%)`);
L(`      • hard stop at mark $${hardStop} (-${cfg.stopPct}%)  ·  or if consensus flips`);
if (alt) L(`    defined-risk alt: ${alt.structure} — risk $${alt.maxLoss} to make $${alt.maxProfit} (caps the upside).`);
L(`    SIZE: confidence ${verdict.confidence}% → ${verdict.confidence >= 60 ? 'normal clip' : 'half clip (45–60% band)'}. Never average down.`);
L(`    GATE: "${verdict.side === 'LONG_PUTS' ? 'short' : 'long'}" vs trend → ${gate ? '⛔ ' + gate : '✓ with the trend'}`);
L('╚═════════════════════════════════════════════════════╝\n');
