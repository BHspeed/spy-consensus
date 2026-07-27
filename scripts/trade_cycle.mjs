#!/usr/bin/env node
/**
 * Auto-trade cycle harness. The deterministic planner in one shot:
 *
 *   broker snapshot + engine state + quotes + candidates  →  planCycle()
 *        →  ordered SELL/BUY actions  +  the next state to persist.
 *
 * This script does NO trading and touches NO network. The live agent (see
 * skills/auto-trade/SKILL.md) gathers the inputs via the Robinhood/Webull MCP
 * tools, writes them into a bundle, runs this to get the exact order list, then
 * places precisely those orders. Running it by hand is the safe way to preview a
 * cycle ("what would the bot do right now?").
 *
 * Usage:
 *   node scripts/trade_cycle.mjs <bundle.json>          # print the plan
 *   node scripts/trade_cycle.mjs <bundle.json> --json   # machine-readable plan
 *   node scripts/trade_cycle.mjs --demo                 # canned example
 *
 * Bundle shape (all fields the agent supplies from live data):
 *   {
 *     "now": 1753600000000,            // epoch ms (agent's clock)
 *     "today": "2026-07-27",           // ET trading day
 *     "marketOpen": true,              // is it the regular session?
 *     "account": { "equity": 100, "buyingPower": 100 },
 *     "state": { ...persisted engine state... },   // {} on first run
 *     "regime": { "riskOn": true, "reason": "SPY > 20-EMA" },  // market gate
 *     "brokerPositions": [ { "symbol":"NVDA","shares":0.1,"avgPrice":120,"tier":"core" } ],
 *     "quotes": { "NVDA": 121.2 },     // current price per held + candidate symbol
 *     "candidates": [ { "symbol":"NVDA","price":121.2,"avgDollarVol":30e9,
 *                       "dayChangePct":1.4,"trendScore":0.6 } ]   // curated universe only
 *   }
 *
 * The printed "NEXT STATE" is what the agent must save back for the next cycle.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/trading/config.js';
import { normalizeState, emptyState } from '../src/trading/state.js';
import { planCycle } from '../src/trading/planner.js';
import { assessRegime, combineRegime } from '../src/trading/regime.js';
import { normalizeSignal } from '../src/trading/spyConsensus.js';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const wantDemo = args.includes('--demo');
const manageOnly = args.includes('--manage'); // 15-min risk heartbeat: exits/trailing only
const file = args.find(a => !a.startsWith('--'));

let bundle;
if (wantDemo || !file) {
  bundle = {
    now: Date.parse('2026-07-27T14:00:00Z'),
    today: '2026-07-27',
    marketOpen: true,
    regime: { riskOn: true, reason: 'SPY > 20-EMA (demo)' },
    account: { equity: 100, buyingPower: 100 },
    state: emptyState(),
    brokerPositions: [],
    quotes: { NVDA: 121.2, TQQQ: 78.5, SOXL: 32.1 },
    candidates: [
      { symbol: 'NVDA', price: 121.2, avgDollarVol: 30e9, dayChangePct: 1.4, trendScore: 0.6 },
      { symbol: 'TQQQ', price: 78.5, avgDollarVol: 3e9, dayChangePct: 2.8, trendScore: 0.5 },
      { symbol: 'SOXL', price: 32.1, avgDollarVol: 2e9, dayChangePct: 3.6, trendScore: 0.45 },
    ],
  };
} else {
  bundle = JSON.parse(readFileSync(file, 'utf8'));
}

const cfg = loadConfig(bundle.config || {});
// Regime: an explicit bundle.regime wins; else derive it from bundle.spy
// {price, priorClose, ema}, then fold in the SPY call-out (bundle.spyConsensus =
// a consensus verdict / {bias, confidence, score}) — a bearish call-out blocks longs.
let regime = bundle.regime;
if (!regime && bundle.spy) {
  const base = assessRegime(bundle.spy, cfg);
  regime = combineRegime(base, normalizeSignal(bundle.spyConsensus), cfg);
}
const input = { ...bundle, regime, state: normalizeState(bundle.state), manageOnly: manageOnly || bundle.manageOnly };
const result = planCycle(input, cfg);

if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const L = (s = '') => console.log(s);
const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

L('\n=================  AUTO-TRADE CYCLE  =================');
L(`  ${bundle.today}   ${bundle.marketOpen ? 'RTH open' : 'MARKET CLOSED'}   ·   equity ${money(bundle.account.equity)}  ·  settled ${money(bundle.account.buyingPower)}`);
L(`  ${result.dailyStop.reason}`);
if (result.dailyGoal) L(`  ${result.dailyGoal.reason}`);
if (regime) L(`  Regime: ${regime.riskOn ? 'RISK-ON' : 'RISK-OFF'} — ${regime.reason}`);
if (result.halted) L('  *** HALTED FOR THE DAY (daily stop/goal) ***');
L('');

if (result.actions.length === 0) {
  L('  No actions this cycle.');
} else {
  const sells = result.actions.filter(a => a.type === 'SELL');
  const buys = result.actions.filter(a => a.type === 'BUY');
  if (sells.length) {
    L('  EXITS (run first):');
    for (const a of sells) {
      const ord = a.orderType === 'limit' ? `limit @ ${money(a.limitPrice)}` : 'market';
      L(`    SELL ${a.shares} ${a.symbol}  (${ord})  — ${a.reason}`);
    }
    L('');
  }
  if (buys.length) {
    L('  ENTRIES:');
    for (const a of buys) {
      const ord = a.orderType === 'limit' ? `limit @ ${money(a.limitPrice)}` : 'market';
      L(`    BUY  ${a.shares} ${a.symbol}  ~${money(a.usd)}  (${a.tier}, ${ord})`);
    }
    L('');
  }
}

if (result.notes.length) {
  L('  notes:');
  for (const n of result.notes) L(`    - ${n}`);
  L('');
}

L('  ---- NEXT STATE (persist this for the next cycle) ----');
L(JSON.stringify(result.nextState));
L('=====================================================\n');
