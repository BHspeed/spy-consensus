import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gradePick, summarizeSwings } from '../src/strategies/swings/swingGrade.js';

const pick = (o = {}) => ({ symbol: 'X', added: '2026-06-01', entry: 100, tier: 'aggressive', targetPct: 30, targetPrice: 130, stopPrice: 90, ...o });

describe('swing grade', () => {
  test('HIT when peak reached target (even if it faded back)', () => {
    const g = gradePick(pick(), { last: 118, highSince: 131, lowSince: 99 }, '2026-06-15');
    assert.equal(g.status, 'hit');
    assert.ok(g.closed);
  });
  test('STOPPED when low breached stop', () => {
    const g = gradePick(pick(), { last: 92, highSince: 108, lowSince: 89 }, '2026-06-10');
    assert.equal(g.status, 'stopped');
  });
  test('EXPIRED after ~1 month without hit/stop', () => {
    const g = gradePick(pick(), { last: 112, highSince: 120, lowSince: 96 }, '2026-07-01');
    assert.equal(g.status, 'expired');
    assert.ok(g.closed);
  });
  test('OPEN gives a weekly progress line', () => {
    const g = gradePick(pick(), { last: 108, highSince: 112, lowSince: 98 }, '2026-06-09');
    assert.equal(g.status, 'open');
    assert.match(g.verdict, /wk\d/);
    assert.ok(g.gainPct > 0 && g.mfePct >= g.gainPct);
  });
  test('falls back to last price when no high/low provided', () => {
    assert.equal(gradePick(pick(), { last: 131 }, '2026-06-10').status, 'hit');
    assert.equal(gradePick(pick(), { last: 89 }, '2026-06-10').status, 'stopped');
  });

  test('summarizeSwings computes hit-rate + by-tier', () => {
    const s = summarizeSwings([
      { status: 'hit', tier: 'aggressive', gainPct: 30, mfePct: 32 },
      { status: 'expired', tier: 'aggressive', gainPct: 8, mfePct: 15 },
      { status: 'hit', tier: 'core', gainPct: 12, mfePct: 14 },
      { status: 'open', tier: 'core' },
    ]);
    assert.equal(s.closed, 3);
    assert.equal(s.hitRate, 66.7);
    assert.equal(s.byTier.aggressive.n, 2);
    assert.equal(s.byTier.aggressive.hitRate, 50);
  });
});
