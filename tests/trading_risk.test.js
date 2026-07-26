/**
 * Unit tests for the auto-trader risk engine. Pure synthetic data — no network.
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

describe('initial stop', () => {
  test('high-cap uses the 3% stop, low-priced the 5% stop', () => {
    assert.equal(initialStop(100, 'highcap', cfg), 97);
    assert.equal(initialStop(10, 'lowpriced', cfg), 9.5);
  });
  test('rejects a bad entry price / unknown tier', () => {
    assert.throws(() => initialStop(0, 'highcap', cfg));
    assert.throws(() => initialStop(10, 'bogus', cfg));
  });
});

describe('trailing ratchet', () => {
  const pos = openPosition({ symbol: 'X', tier: 'highcap', shares: 1, entryPrice: 100, entryTime: 0 }, cfg);

  test('below the arm threshold the stop stays at the initial stop', () => {
    const u = updatePositionRisk(pos, 102, cfg); // +2%, arms at +3%
    assert.equal(u.trailArmed, false);
    assert.equal(u.stop, 97);
  });

  test('arms once up >3% and trails the peak', () => {
    const u = updatePositionRisk(pos, 104, cfg); // +4% → arm, trail 3% below peak
    assert.equal(u.trailArmed, true);
    assert.equal(u.peak, 104);
    assert.equal(u.stop, round4(104 * 0.97)); // 100.88
    assert.ok(u.stop > 97, 'stop ratcheted up above the initial');
  });

  test('stop only moves up, never down', () => {
    let u = updatePositionRisk(pos, 110, cfg);   // peak 110, stop 106.7
    const high = u.stop;
    u = updatePositionRisk(u, 108, cfg);          // pulls back, peak stays 110
    assert.equal(u.peak, 110);
    assert.equal(u.stop, high, 'stop held at the higher level');
  });

  test('locks break-even once peak gain ≥ lock threshold', () => {
    // Wide trail so the trail alone would sit below entry; lock should floor it.
    const c = loadConfig({ risk: { ...cfg.risk, trailPct: 8, lockBreakevenAfterPct: 5 } });
    const u = updatePositionRisk(pos, 106, c); // +6% → lock ≥ entry
    assert.ok(u.stop >= 100, `stop ${u.stop} should be ≥ break-even`);
  });
});

describe('position exit decision', () => {
  const pos = openPosition({ symbol: 'X', tier: 'highcap', shares: 1, entryPrice: 100, entryTime: 0 }, cfg);

  test('holds above the stop', () => {
    assert.equal(decidePositionExit(pos, 101, cfg).action, 'HOLD');
  });
  test('initial stop hit → SELL (initial)', () => {
    const d = decidePositionExit(pos, 96.9, cfg);
    assert.equal(d.action, 'SELL');
    assert.equal(d.kind, 'initial');
  });
  test('trailing stop hit after a run → SELL (trailing)', () => {
    let p = updatePositionRisk(pos, 110, cfg); // arm + peak 110, stop 106.7
    const d = decidePositionExit(p, 106, cfg);  // dips below trailing stop
    assert.equal(d.action, 'SELL');
    assert.equal(d.kind, 'trailing');
    assert.ok(d.gainPct > 0, 'trailing stop still books a profit');
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
    const soon = 1000 * MIN + 10 * MIN; // 10 < 30 min cooldown
    assert.equal(reentryEligible(rec, soon, cfg).eligible, false);
  });
  test('blocked once the per-day cap is hit', () => {
    const rec = { lastStopTime: 0, countToday: cfg.reentry.maxPerSymbolPerDay, day: 'D' };
    assert.equal(reentryEligible(rec, 10_000 * MIN, cfg).eligible, false);
  });
  test('eligible again after cooldown, under the cap', () => {
    const rec = { lastStopTime: 1000 * MIN, countToday: 1, day: 'D' };
    const later = 1000 * MIN + 40 * MIN;
    assert.equal(reentryEligible(rec, later, cfg).eligible, true);
  });
});

function round4(v) { return Math.round(v * 10000) / 10000; }
