/**
 * Unit tests for the direction-consensus engine. Pure synthetic data — no chart
 * or network — so these run anywhere.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, atr, swingScore } from '../src/consensus/indicators.js';
import { buildVerdict } from '../src/consensus/engine.js';
import { decideExit } from '../src/consensus/valueFlip.js';

// Build bars from a close series; OHLC derived with a small symmetric range.
function barsFromCloses(closes, t0 = 1_700_000_000, step = 86400) {
  return closes.map((c, i) => ({
    time: t0 + i * step,
    open: i === 0 ? c : closes[i - 1],
    high: Math.max(c, i === 0 ? c : closes[i - 1]) + 0.4,
    low: Math.min(c, i === 0 ? c : closes[i - 1]) - 0.4,
    close: c,
    volume: 1_000_000,
  }));
}
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)));

describe('indicators', () => {
  test('ema tracks toward recent values', () => {
    const e = ema([1, 1, 1, 1, 1, 5, 5, 5, 5, 5], 3);
    assert.ok(e > 3 && e <= 5);
  });
  test('rsi is high on a pure uptrend, low on a downtrend', () => {
    assert.ok(rsi(linspace(100, 130, 30)) > 70);
    assert.ok(rsi(linspace(130, 100, 30)) < 30);
  });
  test('atr is positive and sane', () => {
    const a = atr(barsFromCloses(linspace(100, 110, 30)), 14);
    assert.ok(a > 0 && a < 5);
  });
  test('swingScore is positive for higher highs/lows', () => {
    assert.equal(swingScore(barsFromCloses(linspace(100, 120, 20)), 20), 1);
    assert.equal(swingScore(barsFromCloses(linspace(120, 100, 20)), 20), -1);
  });
});

describe('consensus engine', () => {
  test('steady uptrend → UP bias, long calls, up trend', () => {
    const daily = barsFromCloses(linspace(620, 730, 90));
    const hourly = barsFromCloses(linspace(725, 731, 40), 1, 3600);
    const v = buildVerdict({ daily, hourly, lastPrice: 731 });
    assert.ok(v.bias === 'UP' || v.bias === 'STRONG_UP', `got ${v.bias}`);
    assert.equal(v.side, 'LONG_CALLS');
    assert.equal(v.dominantTrend, 'UP');
    assert.ok(v.score > 20);
  });

  test('steady downtrend → DOWN bias, long puts', () => {
    const daily = barsFromCloses(linspace(730, 620, 90));
    const v = buildVerdict({ daily, lastPrice: 621 });
    assert.ok(v.bias === 'DOWN' || v.bias === 'STRONG_DOWN', `got ${v.bias}`);
    assert.equal(v.side, 'LONG_PUTS');
    assert.equal(v.dominantTrend, 'DOWN');
  });

  test('choppy/flat → NEUTRAL stand-aside', () => {
    const closes = Array.from({ length: 90 }, (_, i) => 700 + Math.sin(i / 2) * 3);
    const v = buildVerdict({ daily: barsFromCloses(closes), lastPrice: 700 });
    assert.equal(v.bias, 'NEUTRAL');
    assert.equal(v.side, 'STAND_ASIDE');
  });

  test('counter-trend check flags shorting an uptrend (the costly mistake)', () => {
    const daily = barsFromCloses(linspace(620, 740, 90));
    const v = buildVerdict({ daily, lastPrice: 740 });
    assert.ok(v.counterTrendCheck('short'), 'should warn');
    assert.equal(v.counterTrendCheck('long'), null, 'long with the trend is fine');
  });
});

describe('value-flip exit', () => {
  test('holds while rising', () => {
    const d = decideExit(1.00, [1.00, 1.10, 1.25, 1.40]);
    assert.equal(d.action, 'HOLD');
  });
  test('takes profit when it flips down off a profitable peak', () => {
    // peaked +50%, pulled back 33% of the peak gain → flip
    const d = decideExit(1.00, [1.00, 1.20, 1.50, 1.30]);
    assert.equal(d.action, 'TAKE_PROFIT');
    assert.ok(/value flip/i.test(d.reason));
  });
  test('hard stop on bleed', () => {
    assert.equal(decideExit(1.00, [1.00, 0.80, 0.60]).action, 'STOP_OUT');
  });
  test('consensus flip forces exit', () => {
    assert.equal(decideExit(1.00, [1.00, 1.05], { consensusFlipped: true }).action, 'EXIT_SIGNAL');
  });
});
