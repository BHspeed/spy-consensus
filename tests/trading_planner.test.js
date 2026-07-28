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

  test('bearish regime → no new entries', () => {
    const r = planCycle(baseInput({ regime: { riskOn: false, posture: 'bearish', reason: 'SPY red, below EMA' }, candidates: [NVDA], quotes: { NVDA: 120 } }), cfg);
    assert.equal(r.actions.filter(a => a.type === 'BUY').length, 0);
    assert.ok(r.notes.some(n => /no new entries/i.test(n)));
  });

  test('chop regime → buys only strong names (≥ chop momentum floor)', () => {
    const strong = { symbol: 'GOOGL', price: 328, avgDollarVol: 6e9, dayChangePct: 2.8, trendScore: 0.6 };
    const weak = { symbol: 'MSFT', price: 390, avgDollarVol: 6e9, dayChangePct: 1.2, trendScore: 0.4 }; // below 2.5 chop floor
    const r = planCycle(baseInput({ regime: { riskOn: false, posture: 'chop', reason: 'SPY green, below EMA' }, candidates: [strong, weak], quotes: { GOOGL: 328, MSFT: 390 } }), cfg);
    const buys = r.actions.filter(a => a.type === 'BUY').map(a => a.symbol);
    assert.ok(buys.includes('GOOGL'));
    assert.ok(!buys.includes('MSFT'));
  });
});

describe('planner — daily circuit breaker', () => {
  test('daily $ loss brake flattens all and halts, emits no buys', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 400 };
    const r = planCycle(baseInput({
      state,
      account: { equity: 355, buyingPower: 96 }, // -$45, ~11% (< suspect), > $40 brake
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

describe('planner — daily profit goal', () => {
  test('up 5% on the day flattens all + halts + banks (no buys)', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100 };
    const r = planCycle(baseInput({
      state,
      account: { equity: 105.5, buyingPower: 20 }, // +5.5% → goal reached
      brokerPositions: [{ symbol: 'TQQQ', shares: 0.4, avgPrice: 66, tier: 'amp' }],
      quotes: { TQQQ: 72 },
      candidates: [NVDA],
    }), cfg);
    assert.equal(r.halted, true);
    assert.equal(r.dailyGoal.reached, true);
    assert.ok(r.actions.every(a => a.type === 'SELL'));
    assert.ok(r.actions.some(a => a.symbol === 'TQQQ' && /DAILY GOAL/.test(a.reason)));
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

describe('planner — manage-only pass (15-min heartbeat)', () => {
  test('still exits a stopped-out position but places no new entries', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { NVDA: { symbol: 'NVDA', tier: 'core', shares: 0.5, entryPrice: 120, entryTime: 0, stop: 116.4, peak: 120, trailArmed: false } } };
    const r = planCycle(baseInput({
      manageOnly: true,
      state,
      brokerPositions: [{ symbol: 'NVDA', shares: 0.5, avgPrice: 120, tier: 'core' }],
      quotes: { NVDA: 115 },              // under stop → must still sell
      candidates: [{ symbol: 'AMD', price: 100, avgDollarVol: 10e9, dayChangePct: 5, trendScore: 0.9 }], // strong buy, must be ignored
    }), cfg);
    assert.ok(r.actions.some(a => a.type === 'SELL' && a.symbol === 'NVDA'));
    assert.equal(r.actions.filter(a => a.type === 'BUY').length, 0);
  });

  test('ratchets the trailing stop without buying anything', () => {
    const state = { ...emptyState(), day: DAY, baselineEquity: 100,
      positions: { NVDA: { symbol: 'NVDA', tier: 'core', shares: 0.5, entryPrice: 120, entryTime: 0, stop: 116.4, peak: 120, trailArmed: false } } };
    const r = planCycle(baseInput({
      manageOnly: true,
      state,
      brokerPositions: [{ symbol: 'NVDA', shares: 0.5, avgPrice: 120, tier: 'core' }],
      quotes: { NVDA: 127 },              // +5.8% → arm + lock
      candidates: [{ symbol: 'AMD', price: 100, avgDollarVol: 10e9, dayChangePct: 5, trendScore: 0.9 }],
    }), cfg);
    assert.equal(r.actions.length, 0);
    assert.equal(r.nextState.positions.NVDA.trailArmed, true);
    assert.ok(r.nextState.positions.NVDA.stop >= 120);
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
