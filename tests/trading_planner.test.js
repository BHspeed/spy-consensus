/**
 * Unit tests for the full cycle planner — exits before entries, the daily
 * circuit breaker, trailing management across cycles, the closed-market gate,
 * and the market-regime (risk-on/off) gate.
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
    regime: { riskOn: true, reason: 'test' },
    account: { equity: 100, buyingPower: 100 },
    state: emptyState(),
    brokerPositions: [],
    quotes: {},
    candidates: [],
    ...over,
  };
}

const NVDA = { symbol: 'NVDA', price: 120, avgDollarVol: 30e9, dayChangePct: 2, trendScore: 0.5 };

describe('planner — entries', () => {
  test('fresh account buys screened candidates when risk-on', () => {
    const r = planCycle(baseInput({ candidates: [NVDA], quotes: { NVDA: 120 } }), cfg);
    const buys = r.actions.filter(a => a.type === 'BUY');
    assert.ok(buys.length >= 1);
    assert.equal(buys[0].symbol, 'NVDA');
    assert.ok(r.nextState.positions.NVDA);
  });

  test('market closed → no orders', () => {
    const r = planCycle(baseInput({ marketOpen: false, candidates: [NVDA], quotes: { NVDA: 120 } }), cfg);
    assert.equal(r.actions.length, 0);
  });

  test('risk-OFF regime → no new entries', () => {
    const r = planCycle(baseInput({ regime: { riskOn: false, reason: 'SPY < 20-EMA' }, candidates: [NVDA], quotes: { NVDA: 120 } }), cfg);
    assert.equal(r.actions.filter(a => a.type === 'BUY').length, 0);
    assert.ok(r.notes.some(n => /Risk-OFF/.test(n)));
  });
});

describe('planner — daily circuit breaker', () => {
  test('down 3% flattens all and halts, emits no buys', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100 };
    const r = planCycle(baseInput({
      state,
      account: { equity: 96, buyingPower: 96 },
      brokerPositions: [{ symbol: 'NVDA', shares: 0.5, avgPrice: 120, tier: 'core' }],
      quotes: { NVDA: 110 },
      candidates: [NVDA],
    }), cfg);
    assert.equal(r.halted, true);
    assert.ok(r.actions.every(a => a.type === 'SELL'));
    assert.ok(r.actions.some(a => a.symbol === 'NVDA' && /DAILY STOP/.test(a.reason)));
    assert.equal(Object.keys(r.nextState.positions).length, 0);
  });
});

describe('planner — exit management', () => {
  test('a position under its stop is sold before any entry (core → market exit)', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { NVDA: { symbol: 'NVDA', tier: 'core', shares: 0.5, entryPrice: 120, entryTime: 0, stop: 116.4, peak: 120, trailArmed: false } } };
    const r = planCycle(baseInput({
      state,
      brokerPositions: [{ symbol: 'NVDA', shares: 0.5, avgPrice: 120, tier: 'core' }],
      quotes: { NVDA: 115 },
      candidates: [],
    }), cfg);
    const sells = r.actions.filter(a => a.type === 'SELL');
    assert.equal(sells.length, 1);
    assert.equal(sells[0].orderType, 'market');
    assert.ok(!r.nextState.positions.NVDA);
    assert.ok(r.nextState.stoppedOut.NVDA);
  });

  test('a winning position ratchets its stop and is kept', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { NVDA: { symbol: 'NVDA', tier: 'core', shares: 0.5, entryPrice: 120, entryTime: 0, stop: 116.4, peak: 120, trailArmed: false } } };
    const r = planCycle(baseInput({
      state,
      brokerPositions: [{ symbol: 'NVDA', shares: 0.5, avgPrice: 120, tier: 'core' }],
      quotes: { NVDA: 127 }, // +5.8% → arm + lock break-even
      candidates: [],
    }), cfg);
    assert.equal(r.actions.filter(a => a.type === 'SELL').length, 0);
    const p = r.nextState.positions.NVDA;
    assert.equal(p.trailArmed, true);
    assert.ok(p.stop > 116.4);
    assert.ok(p.stop >= 120, 'break-even lock engaged');
  });

  test('exits run even in a risk-off regime (risk reduction never gated)', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { NVDA: { symbol: 'NVDA', tier: 'core', shares: 0.5, entryPrice: 120, entryTime: 0, stop: 116.4, peak: 120, trailArmed: false } } };
    const r = planCycle(baseInput({
      regime: { riskOn: false, reason: 'risk-off' },
      state,
      brokerPositions: [{ symbol: 'NVDA', shares: 0.5, avgPrice: 120, tier: 'core' }],
      quotes: { NVDA: 115 },
      candidates: [],
    }), cfg);
    assert.ok(r.actions.some(a => a.type === 'SELL' && a.symbol === 'NVDA'));
  });
});

describe('planner — reentry cooldown', () => {
  test('does not re-buy a name just stopped out', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      stoppedOut: { NVDA: { lastStopTime: NOW - 5 * 60000, countToday: 1, day: DAY } } };
    const r = planCycle(baseInput({ state, candidates: [NVDA], quotes: { NVDA: 120 } }), cfg);
    assert.ok(!r.actions.some(a => a.type === 'BUY' && a.symbol === 'NVDA'));
  });
});
