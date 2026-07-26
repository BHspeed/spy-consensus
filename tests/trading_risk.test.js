/**
 * Unit tests for the auto-trader risk engine. Pure synthetic data — no network.
 * Tiers: 'core' (megacap, tighter stops) and 'amp' (leveraged ETF, wider stops).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import {
  initialStop, openPosition, updatePositionRisk, decidePositionExit,
  decideDailyStop, reentryEligible,
} from '../src/trading/riskEngine.js';

const cfg = loadConfig();
const MIN = 60000;

describe('initial stop (per tier)', () => {
  test('core uses the 3% stop, amp the wider 7% stop', () => {
    assert.equal(initialStop(100, 'core', cfg), 97);
    assert.equal(initialStop(100, 'amp', cfg), 93);
  });
  test('rejects a bad entry price / unknown tier', () => {
    assert.throws(() => initialStop(0, 'core', cfg));
    assert.throws(() => initialStop(10, 'bogus', cfg));
  });
});

describe('trailing ratchet (core)', () => {
  const pos = openPosition({ symbol: 'NVDA', tier: 'core', shares: 1, entryPrice: 100, entryTime: 0 }, cfg);

  test('below the arm threshold the stop stays at the initial stop', () => {
    const u = updatePositionRisk(pos, 102, cfg); // +2%, arms at +3%
    assert.equal(u.trailArmed, false);
    assert.equal(u.stop, 97);
  });

  test('arms once up >3% and trails 3% below peak', () => {
    const u = updatePositionRisk(pos, 104, cfg); // +4% → arm, trail 3% below peak
    assert.equal(u.trailArmed, true);
    assert.equal(u.peak, 104);
    assert.equal(u.stop, round4(104 * 0.97));
    assert.ok(u.stop > 97);
  });

  test('stop only moves up, never down', () => {
    let u = updatePositionRisk(pos, 110, cfg);
    const high = u.stop;
    u = updatePositionRisk(u, 108, cfg);
    assert.equal(u.peak, 110);
    assert.equal(u.stop, high);
  });

  test('locks break-even once peak gain ≥ 5%', () => {
    const u = updatePositionRisk(pos, 106, cfg); // +6% → lock ≥ entry
    assert.ok(u.stop >= 100, `stop ${u.stop} should be ≥ break-even`);
  });
});

describe('trailing ratchet (amp — wider)', () => {
  const pos = openPosition({ symbol: 'TQQQ', tier: 'amp', shares: 1, entryPrice: 100, entryTime: 0 }, cfg);

  test('does NOT arm at +4% (amp arms at +5%)', () => {
    const u = updatePositionRisk(pos, 104, cfg);
    assert.equal(u.trailArmed, false);
    assert.equal(u.stop, 93); // still the 7% initial stop
  });

  test('arms at +6% and trails 6% below peak', () => {
    const u = updatePositionRisk(pos, 106, cfg);
    assert.equal(u.trailArmed, true);
    assert.equal(u.stop, round4(106 * 0.94));
  });
});

describe('position exit decision', () => {
  const pos = openPosition({ symbol: 'NVDA', tier: 'core', shares: 1, entryPrice: 100, entryTime: 0 }, cfg);

  test('holds above the stop', () => {
    assert.equal(decidePositionExit(pos, 101, cfg).action, 'HOLD');
  });
  test('initial stop hit → SELL (initial)', () => {
    const d = decidePositionExit(pos, 96.9, cfg);
    assert.equal(d.action, 'SELL');
    assert.equal(d.kind, 'initial');
  });
  test('trailing stop hit after a run → SELL (trailing), still green', () => {
    const p = updatePositionRisk(pos, 110, cfg);
    const d = decidePositionExit(p, 106, cfg);
    assert.equal(d.action, 'SELL');
    assert.equal(d.kind, 'trailing');
    assert.ok(d.gainPct > 0);
  });
});

describe('daily circuit breaker', () => {
  test('trips at exactly the 3% drawdown', () => {
    assert.equal(decideDailyStop(100, 97, cfg).tripped, true);
    assert.equal(decideDailyStop(100, 97.5, cfg).tripped, false);
  });
  test('no baseline → never trips', () => {
    assert.equal(decideDailyStop(0, 50, cfg).tripped, false);
  });
});

describe('reentry gate', () => {
  test('fresh symbol is eligible', () => {
    assert.equal(reentryEligible(undefined, 1_000 * MIN, cfg).eligible, true);
  });
  test('blocked inside the cooldown', () => {
    const rec = { lastStopTime: 1000 * MIN, countToday: 1, day: 'D' };
    const soon = 1000 * MIN + 10 * MIN; // 10 < 45 min cooldown
    assert.equal(reentryEligible(rec, soon, cfg).eligible, false);
  });
  test('blocked once the per-day cap is hit', () => {
    const rec = { lastStopTime: 0, countToday: cfg.reentry.maxPerSymbolPerDay, day: 'D' };
    assert.equal(reentryEligible(rec, 10_000 * MIN, cfg).eligible, false);
  });
  test('eligible again after cooldown, under the cap', () => {
    const rec = { lastStopTime: 1000 * MIN, countToday: 1, day: 'D' };
    const later = 1000 * MIN + 60 * MIN;
    assert.equal(reentryEligible(rec, later, cfg).eligible, true);
  });
});

function round4(v) { return Math.round(v * 10000) / 10000; }
