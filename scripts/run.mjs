#!/usr/bin/env node
/**
 * "run it" — the whole pipeline in one shot, plain-English, spread-first.
 *
 *   OHLCV → consensus (UP / DOWN / SIDEWAYS + confidence)
 *         → if tradeable: option chain → TWO spreads (buy-side + sell-side)
 *         → entry / take-profit / stop in plain dollars.
 *
 * Offline demo uses scripts/_data.mjs. Live: pass a freshly-pulled Robinhood
 * bundle (see RUNBOOK.md):  node scripts/run.mjs <bundle.json>
 * Add --log to append the run to logs/spy_runs.jsonl.
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { buildVerdict } from '../src/consensus/engine.js';
import { selectTrades, fromRobinhood } from '../src/consensus/optionSelect.js';
import * as sample from './_data.mjs';

const args = process.argv.slice(2);
const wantLog = args.includes('--log');
const wantSingle = args.includes('--single');
const file = args.find(a => !a.startsWith('--'));
const LOG_PATH = 'logs/spy_runs.jsonl';

// ---- assemble inputs -------------------------------------------------------
let daily, hourly, intraday, priorDay, lastPrice, expiry, contracts, asOf, symbol;
if (file) {
  const b = JSON.parse(readFileSync(file, 'utf8'));
  ({ priorDay, lastPrice, expiry, asOf, symbol } = b);
  daily = b.daily; hourly = b.hourly || []; intraday = b.intraday || [];
  contracts = (b.optionQuotes || []).map(q => fromRobinhood(q.strike, q.type || 'call', q));
} else {
  daily = sample.toBars(sample.dailyRows);
  hourly = sample.toBars(sample.hourlyRows);
  intraday = hourly.slice(-6);
  priorDay = sample.priorDay; lastPrice = sample.lastPrice; expiry = sample.optionExpiry;
  asOf = '2026-06-29 close (offline sample)';
  contracts = [
    ...sample.optionQuotes.map(q => fromRobinhood(q.strike, 'call', q)),
    ...sample.putQuotes.map(q => fromRobinhood(q.strike, 'put', q)),
  ];
}

const verdict = buildVerdict({ daily, hourly, intraday, priorDay, lastPrice });
const dir = verdict.bias.includes('UP') ? 'UP' : verdict.bias.includes('DOWN') ? 'DOWN' : 'SIDEWAYS';
const oppDir = dir === 'UP' ? 'DOWN' : 'UP';
const SYMBOL = symbol || process.env.SYMBOL || 'SPY';
const L = (s = '') => console.log(s);

const logEntry = {
  loggedAt: new Date().toISOString(), asOf, expiry, spot: verdict.lastPrice,
  consensus: { dir, score: verdict.score, confidence: verdict.confidence, adx: verdict.adx },
  decision: null, tradeA: null, tradeB: null,
};
function writeLog() {
  if (!wantLog) return;
  mkdirSync('logs', { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(logEntry) + '\n');
  L(`  (logged → ${LOG_PATH})`);
}

L(`\n===================  ${SYMBOL} — RUN IT  ===================`);
L(`  as of ${asOf}   price ~${verdict.lastPrice}`);
L('');
L(`  CONSENSUS:   ${dir}   ·   ${verdict.confidence}% confident`);

if (dir === 'SIDEWAYS' || verdict.confidence < 45) {
  L('');
  L('  >>> NO TRADE today — direction unclear / low confidence.');
  L('      Sitting out is the call (a result, not a miss).');
  logEntry.decision = 'STAND_ASIDE';
  writeLog();
  L('=====================================================\n');
  process.exit(0);
}
if (!contracts.length) {
  L(`\n  (load the ${expiry} chain for trade choices)`);
  logEntry.decision = 'NO_CHAIN';
  writeLog();
  L('=====================================================\n'); process.exit(0);
}

const sel = selectTrades(verdict, contracts, { maxCandidates: 8 });
const debit = sel.candidates.find(c => c.kind === 'debit_vertical');
const credit = sel.candidates.find(c => c.kind === 'credit_vertical');
const longAlt = sel.candidates.find(c => c.kind === 'long_single');
const buySideWord = dir === 'UP' ? 'CALL spread' : 'PUT spread';
const sellSideWord = dir === 'UP' ? 'PUT spread' : 'CALL spread';

if (debit) {
  const e = debit.cost, mp = debit.maxProfit, maxVal = e + mp;
  const tp = Math.min(maxVal, Math.round(e * 1.3)), st = Math.round(e * 0.7);
  logEntry.tradeA = { structure: debit.structure, pay: e, scalpOut: tp, stop: st, confidence: debit.confidence };
  L('');
  L(`  TRADE A — ${buySideWord}  (BUY, scalp the move ${dir}):   conf ${debit.confidence}%`);
  L(`     ${debit.structure.replace('DEBIT ', 'BUY ')}   (${expiry})`);
  L(`     pay          $${e}`);
  L(`     SCALP OUT  ~ $${tp}    <-- bank the pop (+${Math.round((tp - e) / e * 100)}%); trail if it keeps flipping up`);
  L(`     stop       ~ $${st}    (-${Math.round((1 - st / e) * 100)}%, or if consensus turns ${oppDir})`);
  L(`     room to max  $${maxVal}`);
}
if (credit) {
  const got = credit.credit, buyback = Math.max(1, Math.round(got * 0.5));
  const shortK = credit.legs[0].strike;
  logEntry.tradeB = { structure: credit.structure, collect: got, takeHalf: buyback, maxLoss: credit.maxLoss, confidence: credit.confidence };
  L('');
  L(`  TRADE B — ${sellSideWord}  (SELL, slower — collect & scalp half):   conf ${credit.confidence}%`);
  L(`     ${credit.structure.replace('CREDIT ', 'SELL ')}   (${expiry})`);
  L(`     collect      $${got}`);
  L(`     TAKE HALF  ~ $${buyback}    <-- buy back here, bank ~$${got - buyback} (don't hold for the last dollar)`);
  L(`     max loss     $${credit.maxLoss}   (if ${SYMBOL} ${dir === 'UP' ? 'drops below' : 'runs above'} ${credit.legs[1].strike})`);
  L(`     keeps profit if ${SYMBOL} stays ${dir === 'UP' ? 'above' : 'below'} ${shortK}`);
}

if (wantSingle && longAlt) {
  const e = longAlt.cost;
  logEntry.tradeC = { structure: longAlt.structure, pay: e, bank: Math.round(e * 1.10), target: Math.round(e * 1.20), stop: Math.round(e * 0.80) };
  L('');
  L(`  TRADE C — SINGLE OPTION  (BUY one leg, value-flip scalp):`);
  L(`     BUY ${longAlt.structure.replace('LONG ', '')}   (${expiry})`);
  L(`     pay          $${e}`);
  L(`     BANK +10%  ~ $${Math.round(e * 1.10)}    <-- take the flip when it comes (don't need to be right on strike)`);
  L(`     TARGET +20% ~ $${Math.round(e * 1.20)}`);
  L(`     stop       ~ $${Math.round(e * 0.80)}    (-20%, or if consensus turns ${oppDir})`);
}

L('');
L(`  GOAL: scalp the value flip — bank the pop, don't wait to be 100% right.`);
L(`  size: ${verdict.confidence >= 60 ? 'normal' : 'half'} (${verdict.confidence}% confidence).  never add to a loser.`);
if (longAlt && !wantSingle) L(`  fastest mover (most scalp-y): BUY ${longAlt.structure.replace('LONG ', '')} for ~$${longAlt.cost}.`);
L(`  read: trend is ${dir}. A rides+scalps the move; B is slower income if it just doesn't reverse.`);
logEntry.decision = 'IDEAS';
writeLog();
L('=====================================================\n');
