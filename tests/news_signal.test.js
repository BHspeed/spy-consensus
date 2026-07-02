import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNews, lexiconSentiment, newsVsConsensus } from '../src/news/newsSignal.js';

describe('news signal', () => {
  test('lexicon reads bullish vs bearish headlines', () => {
    assert.ok(lexiconSentiment('Stocks rally to record high on rate cut hopes') > 0);
    assert.ok(lexiconSentiment('Market plunges on recession fears and layoffs') < 0);
    assert.equal(lexiconSentiment('Fed meeting scheduled for Wednesday'), 0);
  });

  test('scoreNews aggregates provided sentiments (weighted)', () => {
    const r = scoreNews([
      { title: 'a', sentiment: 0.8, weight: 2 },
      { title: 'b', sentiment: -0.2, weight: 1 },
    ]);
    assert.ok(r.score > 0.4 && r.score <= 0.8);
    assert.ok(r.label.includes('bullish')); // bullish or mixed-bullish
    assert.equal(r.count, 2);
  });

  test('falls back to lexicon when sentiment missing', () => {
    const r = scoreNews([{ title: 'SPY surges to record high' }, { title: 'tech rally continues' }]);
    assert.ok(r.score > 0);
  });

  test('mixed headlines -> mixed label, drivers surfaced', () => {
    const r = scoreNews([
      { title: 'big rally', sentiment: 0.9 },
      { title: 'sharp selloff', sentiment: -0.9 },
      { title: 'mild gain', sentiment: 0.3 },
    ]);
    assert.ok(r.label.startsWith('mixed') || r.label === 'neutral');
    assert.equal(r.drivers.length, 3);
  });

  test('empty -> no-news, score 0', () => {
    const r = scoreNews([]);
    assert.equal(r.label, 'no-news');
    assert.equal(r.score, 0);
  });

  test('newsVsConsensus tracks agreement (never changes the call)', () => {
    assert.equal(newsVsConsensus(0.5, 'UP'), 'agrees');
    assert.equal(newsVsConsensus(0.5, 'DOWN'), 'disagrees');
    assert.equal(newsVsConsensus(0.05, 'UP'), 'neutral');
  });
});
