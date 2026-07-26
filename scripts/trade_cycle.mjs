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
 *     "brokerPositions": [ { "symbol":"AAPL","shares":0.1,"avgPrice":200,"tier":"highcap" } ],
 *     "quotes": { "AAPL": 201.2 },     // current price per held + candidate symbol
 *     "candidates": [ { "symbol":"AAPL","price":201.2,"marketCap":3e12,
 *                       "avgDollarVol":8e9,"dayChangePct":1.4,"trendScore":0.5 } ]
 *   }
 *
 * The printed "NEXT STATE" is what the agent must save back for the next cycle.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/trading/config.js';
import { normalizeState, emptyState } from '../src/trading/state.js';
import { planCycle } from '../src/trading/planner.js';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const wantDemo = args.includes('--demo');
const file = args.find(a => !a.startsWith('--'));

let bundle;
if (wantDemo || !file) {
  bundle = {
    now: Date.parse('2026-07-27T14:00:00Z'),
    today: '2026-07-27',
    marketOpen: true,
    account: { equity: 100, buyingPower: 100 },
    state: emptyState(),
    brokerPositions: [],
    quotes: { AAPL: 201.2, SOFI: 8.4 },
    candidates: [
      { symbol: 'AAPL', price: 201.2, marketCap: 3.1e12, avgDollarVol: 8e9, dayChangePct: 1.4, trendScore: 0.55 },
      { symbol: 'SOFI', price: 8.4, marketCap: 9e9, avgDollarVol: 300e6, dayChangePct: 3.1, trendScore: 0.4 },
    ],
  };
} else {
  bundle = JSON.parse(readFileSync(file, 'utf8'));
}

const cfg = loadConfig(bundle.config || {});
const input = { ...bundle, state: normalizeState(bundle.state) };
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
if (result.halted) L('  *** HALTED FOR THE DAY (daily stop) ***');
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
