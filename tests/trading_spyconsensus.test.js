/**
 * Unit tests for the SPY consensus adapter + regime folding + option intent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { normalizeSignal, optionIntent } from '../src/trading/spyConsensus.js';
import { assessRegime, combineRegime } from '../src/trading/regime.js';

const cfg = loadConfig();

describe('normalizeSignal', () => {
  test('strong bullish call-out → allow longs, strong conviction', () => {
    const s = normalizeSignal({ bias: 'STRONG_UP', confidence: 72, score: 61 });
    assert.equal(s.allowLongs, true);
    assert.equal(s.conviction, 'strong');
  });
  test('bearish call-out → block longs', () => {
    const s = normalizeSignal({ bias: 'DOWN', confidence: 55 });
    assert.equal(s.allowLongs, false);
    assert.equal(s.bearish, true);
  });
  test('UP but low confidence → moderate (not strong)', () => {
    assert.equal(normalizeSignal({ bias: 'UP', confidence: 50 }).conviction, 'moderate');
  });
  test('null verdict → null', () => {
    assert.equal(normalizeSignal(null), null);
  });
});

describe('combineRegime', () => {
  const base = assessRegime({ price: 745.25, priorClose: 738.93, ema: 742 }, cfg); // risk-on

  test('bearish call-out forces risk-off even on a green day', () => {
    const r = combineRegime(base, normalizeSignal({ bias: 'STRONG_DOWN', confidence: 65 }), cfg);
    assert.equal(base.riskOn, true);
    assert.equal(r.riskOn, false);
    assert.match(r.reason, /BLOCKED/);
  });
  test('bullish call-out passes the base regime through', () => {
    const r = combineRegime(base, normalizeSignal({ bias: 'UP', confidence: 55 }), cfg);
    assert.equal(r.riskOn, true);
    assert.equal(r.conviction, 'moderate');
  });
  test('no signal → base unchanged', () => {
    assert.deepEqual(combineRegime(base, null, cfg), base);
  });
});

describe('optionIntent', () => {
  test('enabled by default + strong call-out → consider a call', () => {
    const r = optionIntent(normalizeSignal({ bias: 'STRONG_UP', confidence: 70 }), cfg);
    assert.equal(r.consider, true);
    assert.equal(r.target.side, 'call');
  });
  test('moderate meets the default minConviction (moderate)', () => {
    assert.equal(optionIntent(normalizeSignal({ bias: 'UP', confidence: 50 }), cfg).consider, true);
  });
  test('neutral call-out → skip', () => {
    assert.equal(optionIntent(normalizeSignal({ bias: 'NEUTRAL', confidence: 30 }), cfg).consider, false);
  });
  test('raising minConviction to strong filters out moderate', () => {
    const c = loadConfig({ options: { ...cfg.options, minConviction: 'strong' } });
    assert.equal(optionIntent(normalizeSignal({ bias: 'UP', confidence: 50 }), c).consider, false);
  });
});
