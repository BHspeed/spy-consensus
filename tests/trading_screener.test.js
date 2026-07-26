/**
 * Unit tests for the universe screener + position sizing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { screen } from '../src/trading/screener.js';
import { planEntries } from '../src/trading/sizing.js';

const cfg = loadConfig();

const HIGHCAP = { symbol: 'AAPL', price: 210, marketCap: 3.2e12, avgDollarVol: 8e9, dayChangePct: 1.5, trendScore: 0.6 };
const LOWPRICED = { symbol: 'ABCD', price: 6, marketCap: 800e6, avgDollarVol: 40e6, dayChangePct: 3.2, trendScore: 0.4 };

describe('screener', () => {
  test('classifies and keeps a valid high-cap + low-priced mix', () => {
    const { picks } = screen([HIGHCAP, LOWPRICED], cfg);
    const byTier = Object.fromEntries(picks.map(p => [p.symbol, p.tier]));
    assert.equal(byTier.AAPL, 'highcap');
    assert.equal(byTier.ABCD, 'lowpriced');
  });

  test('rejects penny stocks below the low-priced floor', () => {
    const penny = { ...LOWPRICED, symbol: 'PNY', price: 0.4 };
    const { picks, rejected } = screen([penny], cfg);
    assert.equal(picks.length, 0);
    assert.ok(rejected.some(r => r.symbol === 'PNY'));
  });

  test('rejects illiquid names', () => {
    const thin = { ...LOWPRICED, symbol: 'THN', avgDollarVol: 1e6 };
    const { picks } = screen([thin], cfg);
    assert.equal(picks.length, 0);
  });

  test('rejects negative-momentum names (momentum gate)', () => {
    const falling = { ...HIGHCAP, symbol: 'FALL', dayChangePct: -2 };
    const { picks } = screen([falling], cfg);
    assert.equal(picks.length, 0);
  });

  test('ranks stronger momentum higher', () => {
    const a = { ...HIGHCAP, symbol: 'A', dayChangePct: 0.5 };
    const b = { ...HIGHCAP, symbol: 'B', dayChangePct: 4.5 };
    const { picks } = screen([a, b], cfg);
    assert.equal(picks[0].symbol, 'B');
  });
});

describe('sizing', () => {
  test('splits a $100 account across the high-cap/low-priced mix', () => {
    const { picks } = screen([HIGHCAP, LOWPRICED], cfg);
    const { entries } = planEntries(
      { equity: 100, settledCash: 100, openPositions: [], picks }, cfg);
    assert.ok(entries.length >= 1);
    const total = entries.reduce((s, e) => s + e.usd, 0);
    assert.ok(total <= 95 + 0.01, `deployed ${total} must respect the 5% cash buffer`);
    const hc = entries.find(e => e.tier === 'highcap');
    const lp = entries.find(e => e.tier === 'lowpriced');
    if (hc) assert.equal(hc.orderType, 'market');   // fractional
    if (lp) assert.equal(lp.orderType, 'limit');     // whole shares
  });

  test('respects the max-position cap', () => {
    const { picks } = screen([HIGHCAP, LOWPRICED], cfg);
    const { entries } = planEntries(
      { equity: 100, settledCash: 100, openPositions: [], picks }, cfg);
    for (const e of entries) assert.ok(e.usd <= 30 + 0.01, `${e.symbol} ${e.usd} <= 30% cap`);
  });

  test('deploys only settled cash (GFV guard)', () => {
    const { picks } = screen([HIGHCAP, LOWPRICED], cfg);
    const { entries } = planEntries(
      { equity: 100, settledCash: 10, openPositions: [], picks }, cfg);
    const total = entries.reduce((s, e) => s + e.usd, 0);
    assert.ok(total <= 10, `only settled cash deployable, got ${total}`);
  });

  test('no free slots → no entries', () => {
    const open = Array.from({ length: cfg.sizing.maxPositions }, (_, i) => ({ symbol: `S${i}`, tier: 'highcap' }));
    const { picks } = screen([HIGHCAP], cfg);
    const { entries } = planEntries({ equity: 100, settledCash: 100, openPositions: open, picks }, cfg);
    assert.equal(entries.length, 0);
  });

  test('does not re-buy a symbol already held', () => {
    const { picks } = screen([HIGHCAP, LOWPRICED], cfg);
    const { entries } = planEntries(
      { equity: 100, settledCash: 100, openPositions: [{ symbol: 'AAPL', tier: 'highcap' }], picks }, cfg);
    assert.ok(!entries.some(e => e.symbol === 'AAPL'));
  });
});
