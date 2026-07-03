import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEarnings } from '../src/strategies/earnings/earningsAnalyze.js';

describe('earnings analyzer', () => {
  test('beat + stock up → bullish', () => {
    const a = analyzeEarnings({ symbol: 'AVAV', epsEstimate: 1.48, epsActual: 1.84, priceReactionPct: 18.8 });
    assert.equal(a.beat, true);
    assert.equal(a.surprisePct, 24.3);
    assert.equal(a.verdict, 'bullish');
    assert.equal(a.priceImpact, 'positive');
  });

  test('beat but stock DOWN → bearish divergence (priced in / soft guidance)', () => {
    const a = analyzeEarnings({ symbol: 'X', epsEstimate: 2.0, epsActual: 2.2, priceReactionPct: -5 });
    assert.equal(a.beat, true);
    assert.equal(a.verdict, 'bearish divergence');
    assert.match(a.note, /priced in|soft guidance/);
  });

  test('miss but stock UP → bullish divergence (resilient)', () => {
    const a = analyzeEarnings({ symbol: 'FIZZ', epsEstimate: 0.47, epsActual: 0.43, priceReactionPct: 7.5 });
    assert.equal(a.beat, false);
    assert.equal(a.verdict, 'bullish divergence');
  });

  test('miss + stock down → clean bearish', () => {
    const a = analyzeEarnings({ symbol: 'Y', epsEstimate: 1.0, epsActual: 0.7, priceReactionPct: -8 });
    assert.equal(a.verdict, 'bearish');
    assert.equal(a.magnitude, 'large');
  });

  test('beat + muted → neutral-bullish (no follow-through)', () => {
    const a = analyzeEarnings({ symbol: 'STZ', epsEstimate: 3.21, epsActual: 3.43, priceReactionPct: -1.6 });
    assert.equal(a.verdict, 'neutral-bullish');
  });

  test('not yet reported → upcoming (event risk)', () => {
    const a = analyzeEarnings({ symbol: 'Z', epsEstimate: 1.0, epsActual: null });
    assert.equal(a.reported, false);
    assert.equal(a.verdict, 'upcoming');
  });

  test('reported, reaction pending → lean, not a final verdict', () => {
    const a = analyzeEarnings({ symbol: 'Q', epsEstimate: 1.0, epsActual: 1.2, priceReactionPct: null });
    assert.equal(a.verdict, 'lean bullish');
  });
});
