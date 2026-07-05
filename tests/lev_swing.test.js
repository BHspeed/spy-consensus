import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLevSwing, rankLevSwings } from '../src/strategies/levetf/levSwing.js';

const mkBars = (prices) => prices.map((p) => ({ c: p, h: p * 1.01, l: p * 0.99 }));
const meta = { etf: 'X', parent: 'PAR', lev: 2 };

describe('leveraged ETF swing scorer', () => {
  test('oversold slide into the low qualifies', () => {
    const s = scoreLevSwing(mkBars(Array.from({ length: 25 }, (_, i) => 100 - i * 1.2)), meta);
    assert.ok(s.qualifies);
    assert.ok(s.rsi < 45);
    assert.ok(s.pullbackPct > 12 && s.distToLowPct < 8);
  });

  test('a strong uptrend (not at a low) does NOT qualify', () => {
    const s = scoreLevSwing(mkBars(Array.from({ length: 25 }, (_, i) => 100 + i * 0.8)), meta);
    assert.equal(s.qualifies, false);
  });

  test('target/stop consistent; parent move = target ÷ leverage', () => {
    const s = scoreLevSwing(mkBars(Array.from({ length: 25 }, (_, i) => 100 - i * 1.2)), meta);
    assert.ok(s.target > s.price && s.stop < s.price);
    assert.equal(s.parentMovePct, Math.round((s.targetPct / meta.lev) * 10) / 10);
  });

  test('rankLevSwings filters non-qualifiers and sorts by score', () => {
    const a = scoreLevSwing(mkBars(Array.from({ length: 25 }, (_, i) => 100 - i * 1.5)), { etf: 'A', parent: 'p', lev: 3 });
    const b = scoreLevSwing(mkBars(Array.from({ length: 25 }, (_, i) => 100 + i)), { etf: 'B', parent: 'p', lev: 2 });
    const r = rankLevSwings([b, a]);
    assert.equal(r.length, 1);
    assert.equal(r[0].etf, 'A');
  });
});
