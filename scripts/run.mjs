#!/usr/bin/env node
/**
 * "run it" — the whole pipeline in one shot, plain-English.
 *
 *   OHLCV → consensus (UP / DOWN / SIDEWAYS + confidence)
 *         → if tradeable: option chain → ONE spread to trade (we favor spreads)
 *         → entry price, take-profit area, stop, in dollars.
 *
 * Offline demo uses scripts/_data.mjs. Live run: same, but bars + option quotes
 * come from a freshly-pulled Robinhood bundle (see RUNBOOK.md):
 *   node scripts/run.mjs <bundle.json>
 */
import { readFileSync } from 'node:fs';
import { buildVerdict } from '../src/consensus/engine.js';
import { selectTrades, fromRobinhood } from '../src/consensus/optionSelect.js';
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
  contracts = sample.optionQuotes.map(q => fromRobinhood(q.strike, 'call', q));
}

const verdict = buildVerdict({ daily, hourly, intraday, priorDay, lastPrice });
const dir = verdict.bias.includes('UP') ? 'UP' : verdict.bias.includes('DOWN') ? 'DOWN' : 'SIDEWAYS';
const L = (s = '') => console.log(s);

L('\n===================  SPY — RUN IT  ===================');
L(`  as of ${asOf}   price ~${verdict.lastPrice}`);
L('');
L(`  CONSENSUS:   ${dir}   ·   ${verdict.confidence}% confident`);

// ---- stand-aside gate ------------------------------------------------------
if (dir === 'SIDEWAYS' || verdict.confidence < 45) {
  L('');
  L('  >>> NO TRADE today — direction unclear / low confidence.');
  L('      Sitting out is the call (a result, not a miss).');
  L('=====================================================\n');
  process.exit(0);
}
if (!contracts.length) {
  L(`\n  (load the ${expiry} ${dir === 'DOWN' ? 'put' : 'call'} chain for trade choices)`);
  L('=====================================================\n');
  process.exit(0);
}

const sel = selectTrades(verdict, contracts, { maxCandidates: 6 });
const spreads = sel.candidates.filter(c => c.kind === 'debit_vertical');
const longs = sel.candidates.filter(c => c.kind === 'long_single');
const pick = spreads[0] || sel.candidates[0];          // we favor spreads
const longAlt = longs[0];
const spreadWord = verdict.side === 'LONG_PUTS' ? 'PUT spread' : 'CALL spread';
const oppDir = dir === 'UP' ? 'DOWN' : 'UP';

// ---- concrete entry / take-profit / stop in dollars ------------------------
const entry = pick.cost;
const isSpread = pick.kind === 'debit_vertical';
const maxProfit = isSpread ? pick.maxProfit : null;
const takeProfit = isSpread ? Math.round(entry + 0.6 * maxProfit) : Math.round(entry * 1.5);
const stop = Math.round(entry * (isSpread ? 0.6 : 0.65));
const tpPct = Math.round(((takeProfit - entry) / entry) * 100);
const shortStrike = pick.legs[pick.legs.length - 1].strike;
const buyLine = pick.structure.replace('DEBIT ', 'BUY ').replace('LONG ', 'BUY ');

L('');
L(`  TRADE  (${spreadWord}, ${expiry}):`);
L(`     ${buyLine}`);
L(`     pay about      $${entry}`);
L(`     TAKE PROFIT ~  $${takeProfit}     <-- bank it around here (+${tpPct}%)`);
L(`     stop out    ~  $${stop}      (or if consensus turns ${oppDir})`);
if (isSpread) L(`     most it's worth:   $${entry + maxProfit}  (if it goes perfect)`);
L('');
L(`     why:  trend is ${dir}; this gains as SPY goes ${dir === 'UP' ? 'up toward' : 'down toward'} ${shortStrike}.`);
L(`     size: ${verdict.confidence >= 60 ? 'normal' : 'half'} (${verdict.confidence}% confidence).  never add to a loser.`);
if (longAlt) L(`     uncapped version: BUY ${longAlt.structure.replace('LONG ', '')} for ~$${longAlt.cost}.`);
L('');
L('  other choices:');
sel.candidates.slice(0, 5).forEach(t => {
  const tag = t.kind === 'debit_vertical' ? `spread, max +$${t.maxProfit}` : 'long, uncapped';
  L(`     ${String(t.confidence).padStart(2)}%  ${t.structure.replace('DEBIT ', '').replace('LONG ', 'long ')}  $${t.cost} (${tag})`);
});
L('');
L(`  note: on ${oppDir === 'UP' ? 'DOWN' : 'UP'}-consensus days this is a ${verdict.side === 'LONG_PUTS' ? 'put' : 'call'} spread; a DOWN day gives a put spread (your usual).`);
L('=====================================================\n');
