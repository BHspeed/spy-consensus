import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSwing, rankSwings } from '../src/strategies/swings/swingScore.js';

describe('swing scorer', () => {
  test('small-cap high-range name → aggressive tier, 20-30% target', () => {
    const s = scoreSwing({ symbol: 'ACMR', price: 118, marketCap: 8.1e9, high52: 127, low52: 23 });
    assert.equal(s.tier, 'aggressive');
    assert.ok(s.targetPct >= 20 && s.targetPct <= 30);
    assert.ok(s.rr >= 2);
    assert.ok(s.qualifies);
  });

  test('large-cap → core tier, 10-15% target', () => {
    const s = scoreSwing({ symbol: 'DELL', price: 425, marketCap: 276e9, high52: 469, low52: 110 });
    assert.equal(s.tier, 'core');
    assert.ok(s.targetPct >= 10 && s.targetPct <= 15);
  });

  test('at 52w high → breakout setup; below → room/pullback label', () => {
    assert.match(scoreSwing({ symbol: 'X', price: 100, marketCap: 5e9, high52: 100.5, low52: 40 }).setup, /breakout/);
    assert.match(scoreSwing({ symbol: 'Y', price: 100, marketCap: 5e9, high52: 130, low52: 55 }).setup, /room|pullback/);
  });

  test('target/stop/prices are consistent', () => {
    const s = scoreSwing({ symbol: 'Z', price: 100, marketCap: 8e9, high52: 108, low52: 20 });
    assert.equal(s.targetPrice, Math.round(100 * (1 + s.targetPct / 100) * 10) / 10);
    assert.equal(s.stopPrice, Math.round(100 * (1 - s.stopPct / 100) * 10) / 10);
    assert.ok(s.targetPrice > s.price && s.stopPrice < s.price);
  });

  test('rankSwings filters non-qualifiers and sorts by target×R:R', () => {
    const scored = [
      scoreSwing({ symbol: 'A', price: 100, marketCap: 8e9, high52: 110, low52: 20 }),  // aggressive
      scoreSwing({ symbol: 'B', price: 100, marketCap: 300e9, high52: 105, low52: 80 }), // core, low
    ];
    const r = rankSwings(scored);
    assert.ok(r.length >= 1);
    assert.equal(r[0].symbol, 'A'); // aggressive ranks first
  });
});
