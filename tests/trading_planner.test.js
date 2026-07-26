/**
 * Unit tests for the full cycle planner — exits before entries, the daily
 * circuit breaker, trailing management across cycles, and the closed-market gate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { emptyState } from '../src/trading/state.js';
import { planCycle } from '../src/trading/planner.js';

const cfg = loadConfig();
const DAY = '2026-07-27';
const NOW = Date.parse('2026-07-27T14:00:00Z');

function baseInput(over = {}) {
  return {
    now: NOW, today: DAY, marketOpen: true,
    account: { equity: 100, buyingPower: 100 },
    state: emptyState(),
    brokerPositions: [],
    quotes: {},
    candidates: [],
    ...over,
  };
}

const AAPL = { symbol: 'AAPL', price: 200, marketCap: 3e12, avgDollarVol: 8e9, dayChangePct: 2, trendScore: 0.5 };

describe('planner — entries', () => {
  test('fresh account buys screened candidates', () => {
    const r = planCycle(baseInput({ candidates: [AAPL], quotes: { AAPL: 200 } }), cfg);
    const buys = r.actions.filter(a => a.type === 'BUY');
    assert.ok(buys.length >= 1);
    assert.equal(buys[0].symbol, 'AAPL');
    assert.ok(r.nextState.positions.AAPL, 'position recorded in next state');
  });

  test('market closed → no orders', () => {
    const r = planCycle(baseInput({ marketOpen: false, candidates: [AAPL], quotes: { AAPL: 200 } }), cfg);
    assert.equal(r.actions.length, 0);
  });
});

describe('planner — daily circuit breaker', () => {
  test('down 3% flattens all and halts, emits no buys', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100 };
    const r = planCycle(baseInput({
      state,
      account: { equity: 96, buyingPower: 96 },
      brokerPositions: [{ symbol: 'AAPL', shares: 0.5, avgPrice: 200, tier: 'highcap' }],
      quotes: { AAPL: 190 },
      candidates: [AAPL],
    }), cfg);
    assert.equal(r.halted, true);
    assert.ok(r.actions.every(a => a.type === 'SELL'), 'only sells when halted');
    assert.ok(r.actions.some(a => a.symbol === 'AAPL' && /DAILY STOP/.test(a.reason)));
    assert.equal(Object.keys(r.nextState.positions).length, 0);
  });
});

describe('planner — exit management', () => {
  test('a position under its stop is sold before any entry', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { AAPL: { symbol: 'AAPL', tier: 'highcap', shares: 0.5, entryPrice: 200, entryTime: 0, stop: 194, peak: 200, trailArmed: false } } };
    const r = planCycle(baseInput({
      state,
      brokerPositions: [{ symbol: 'AAPL', shares: 0.5, avgPrice: 200, tier: 'highcap' }],
      quotes: { AAPL: 193 },  // below the 194 stop
      candidates: [],
    }), cfg);
    const sells = r.actions.filter(a => a.type === 'SELL');
    assert.equal(sells.length, 1);
    assert.equal(sells[0].symbol, 'AAPL');
    assert.equal(sells[0].orderType, 'market'); // fractional high-cap exits market
    assert.ok(!r.nextState.positions.AAPL, 'sold position removed from state');
    assert.ok(r.nextState.stoppedOut.AAPL, 'stop-out recorded for reentry cooldown');
  });

  test('a winning position ratchets its stop and is kept', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { AAPL: { symbol: 'AAPL', tier: 'highcap', shares: 0.5, entryPrice: 200, entryTime: 0, stop: 194, peak: 200, trailArmed: false } } };
    const r = planCycle(baseInput({
      state,
      brokerPositions: [{ symbol: 'AAPL', shares: 0.5, avgPrice: 200, tier: 'highcap' }],
      quotes: { AAPL: 210 },  // +5% → arm + ratchet
      candidates: [],
    }), cfg);
    assert.equal(r.actions.filter(a => a.type === 'SELL').length, 0);
    const p = r.nextState.positions.AAPL;
    assert.equal(p.trailArmed, true);
    assert.ok(p.stop > 194, 'stop ratcheted up');
    assert.ok(p.stop >= 200, 'break-even lock engaged at +5%');
  });
});

describe('planner — reentry cooldown', () => {
  test('does not re-buy a name just stopped out', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      stoppedOut: { AAPL: { lastStopTime: NOW - 5 * 60000, countToday: 1, day: DAY } } };
    const r = planCycle(baseInput({ state, candidates: [AAPL], quotes: { AAPL: 200 } }), cfg);
    assert.ok(!r.actions.some(a => a.type === 'BUY' && a.symbol === 'AAPL'));
  });
});
