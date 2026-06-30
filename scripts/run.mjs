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
const file = args.find(a => !a.startsWith('--'));
const LOG_PATH = 'logs/spy_runs.jsonl';

// ---- assemble inputs -------------------------------------------------------
let daily, hourly, intraday, priorDay, lastPrice, expiry, contracts, asOf;
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
  contracts = [
    ...sample.optionQuotes.map(q => fromRobinhood(q.strike, 'call', q)),
    ...sample.putQuotes.map(q => fromRobinhood(q.strike, 'put', q)),
  ];
}

const verdict = buildVerdict({ daily, hourly, intraday, priorDay, lastPrice });
const dir = verdict.bias.includes('UP') ? 'UP' : verdict.bias.includes('DOWN') ? 'DOWN' : 'SIDEWAYS';
const oppDir = dir === 'UP' ? 'DOWN' : 'UP';
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

L('\n===================  SPY — RUN IT  ===================');
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
  const e = debit.cost, mp = debit.maxProfit;
  const tp = Math.round(e + 0.6 * mp), st = Math.round(e * 0.6);
  logEntry.tradeA = { structure: debit.structure, pay: e, takeProfit: tp, stop: st, confidence: debit.confidence };
  L('');
  L(`  TRADE A — ${buySideWord}  (BUY, rides the move ${dir}):   conf ${debit.confidence}%`);
  L(`     ${debit.structure.replace('DEBIT ', 'BUY ')}   (${expiry})`);
  L(`     pay          $${e}`);
  L(`     TAKE PROFIT ~$${tp}    <-- bank around here (+${Math.round((tp - e) / e * 100)}%)`);
  L(`     stop       ~ $${st}    (or if consensus turns ${oppDir})`);
  L(`     most worth   $${e + mp}`);
}
if (credit) {
  const got = credit.credit, buyback = Math.max(1, Math.round(got * 0.4));
  const shortK = credit.legs[0].strike;
  logEntry.tradeB = { structure: credit.structure, collect: got, takeProfit: buyback, maxLoss: credit.maxLoss, confidence: credit.confidence };
  L('');
  L(`  TRADE B — ${sellSideWord}  (SELL, collect & wait):   conf ${credit.confidence}%`);
  L(`     ${credit.structure.replace('CREDIT ', 'SELL ')}   (${expiry})`);
  L(`     collect      $${got}`);
  L(`     TAKE PROFIT ~$${buyback}    <-- buy back here (keep ~$${got - buyback})`);
  L(`     max loss     $${credit.maxLoss}   (if SPY ${dir === 'UP' ? 'drops below' : 'runs above'} ${credit.legs[1].strike})`);
  L(`     keeps profit if SPY stays ${dir === 'UP' ? 'above' : 'below'} ${shortK}`);
}

L('');
L(`  size: ${verdict.confidence >= 60 ? 'normal' : 'half'} (${verdict.confidence}% confidence).  never add to a loser.`);
if (longAlt) L(`  uncapped alt: BUY ${longAlt.structure.replace('LONG ', '')} for ~$${longAlt.cost}.`);
L(`  read: trend is ${dir}. A profits if it keeps going; B profits if it just doesn't reverse.`);
logEntry.decision = 'IDEAS';
writeLog();
L('=====================================================\n');
