import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTheme, rankTheme } from '../src/strategies/theme/themeScore.js';

const mk = (prices) => prices.map((p) => ({ c: p, h: p * 1.005, l: p * 0.995 }));
const meta = { ticker: 'X', group: 'Quantum', name: 'x' };

describe('theme scorer', () => {
  test('rising into the high → breakout', () => {
    const s = scoreTheme(mk(Array.from({ length: 30 }, (_, i) => 100 + i)), meta);
    assert.equal(s.state, 'breakout');
    assert.ok(s.chg21 > 0 && s.aboveMA);
  });

  test('steady decline → oversold (below MA, low RSI)', () => {
    const s = scoreTheme(mk(Array.from({ length: 30 }, (_, i) => 100 - i * 1.5)), meta);
    assert.equal(s.state, 'oversold');
    assert.equal(s.aboveMA, false);
    assert.ok(s.rsi < 38);
  });

  test('returns week/month change + a display tag', () => {
    const s = scoreTheme(mk(Array.from({ length: 30 }, (_, i) => 100 + i)), meta);
    assert.equal(typeof s.chg5, 'number');
    assert.equal(typeof s.chg21, 'number');
    assert.ok(s.tag && s.ticker === 'X');
  });

  test('rankTheme sorts strongest momentum first', () => {
    const up = scoreTheme(mk(Array.from({ length: 30 }, (_, i) => 100 + i)), { ticker: 'UP', group: 'g', name: 'u' });
    const dn = scoreTheme(mk(Array.from({ length: 30 }, (_, i) => 100 - i)), { ticker: 'DN', group: 'g', name: 'd' });
    assert.equal(rankTheme([dn, up])[0].ticker, 'UP');
  });
});
