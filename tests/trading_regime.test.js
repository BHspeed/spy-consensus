/**
 * Unit tests for the market-regime assessor and the daily profit goal.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { assessRegime } from '../src/trading/regime.js';
import { decideDailyGoal, decideDailyStop } from '../src/trading/riskEngine.js';

const cfg = loadConfig();

describe('regime assessor', () => {
  test('green + above short EMA → risk-on', () => {
    const r = assessRegime({ price: 745.25, priorClose: 738.93, ema: 742 }, cfg);
    assert.equal(r.riskOn, true);
    assert.ok(r.dayChangePct > 0);
  });

  test('green but below short EMA → risk-off (bounce under trend)', () => {
    const r = assessRegime({ price: 691.1, priorClose: 684.23, ema: 708.14 }, cfg);
    assert.equal(r.riskOn, false);
  });

  test('red on the day → risk-off even if above EMA', () => {
    const r = assessRegime({ price: 740, priorClose: 745, ema: 730 }, cfg);
    assert.equal(r.riskOn, false);
  });

  test('within EMA tolerance counts as above ("on the line")', () => {
    // price 0.1% under EMA, tolerance 0.2% → treated as above
    const r = assessRegime({ price: 999, priorClose: 990, ema: 1000 }, cfg);
    assert.equal(r.riskOn, true);
  });

  test('no ema provided → green-only gate', () => {
    assert.equal(assessRegime({ price: 101, priorClose: 100 }, cfg).riskOn, true);
    assert.equal(assessRegime({ price: 99, priorClose: 100 }, cfg).riskOn, false);
  });
});

describe('daily profit goal', () => {
  test('reached at the configured goal %', () => {
    assert.equal(decideDailyGoal(100, 105, cfg).reached, true);   // +5% = goal
    assert.equal(decideDailyGoal(100, 104.9, cfg).reached, false);
  });
  test('goal and stop are mutually exclusive', () => {
    const up = decideDailyGoal(100, 106, cfg);
    const upStop = decideDailyStop(100, 106, cfg);
    assert.equal(up.reached, true);
    assert.equal(upStop.tripped, false);
  });
  test('no baseline → not reached', () => {
    assert.equal(decideDailyGoal(0, 200, cfg).reached, false);
  });
});
