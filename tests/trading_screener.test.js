/**
 * Unit tests for the universe screener + position sizing.
 * Universe: curated core (megacap) + amp (leveraged ETF). Junk is rejected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { screen } from '../src/trading/screener.js';
import { planEntries } from '../src/trading/sizing.js';

const cfg = loadConfig();

const NVDA = { symbol: 'NVDA', price: 120, avgDollarVol: 30e9, dayChangePct: 1.5, trendScore: 0.6 };  // core
const TQQQ = { symbol: 'TQQQ', price: 78, avgDollarVol: 3e9, dayChangePct: 3.2, trendScore: 0.4 };    // amp

describe('screener', () => {
  test('classifies curated names into the right tier', () => {
    const { picks } = screen([NVDA, TQQQ], cfg);
    const byTier = Object.fromEntries(picks.map(p => [p.symbol, p.tier]));
    assert.equal(byTier.NVDA, 'core');
    assert.equal(byTier.TQQQ, 'amp');
  });

  test('rejects symbols outside the curated universe (no penny junk)', () => {
    const junk = { symbol: 'PNY', price: 0.4, avgDollarVol: 5e6, dayChangePct: 20, trendScore: 1 };
    const { picks, rejected } = screen([junk], cfg);
    assert.equal(picks.length, 0);
    assert.ok(rejected.some(r => r.symbol === 'PNY' && /curated/.test(r.reason)));
  });

  test('rejects downtrend names (no falling knives)', () => {
    const falling = { ...NVDA, trendScore: -0.5 };
    assert.equal(screen([falling], cfg).picks.length, 0);
  });

  test('rejects flat/negative momentum below the gate', () => {
    const flat = { ...TQQQ, dayChangePct: 0.1 };
    assert.equal(screen([flat], cfg).picks.length, 0);
  });

  test('ranks stronger momentum higher', () => {
    const a = { ...NVDA, symbol: 'AAPL', dayChangePct: 0.5 };
    const b = { ...NVDA, symbol: 'AMD', dayChangePct: 4.5 };
    const { picks } = screen([a, b], cfg);
    assert.equal(picks[0].symbol, 'AMD');
  });
});

describe('sizing (concentrated)', () => {
  test('splits a $100 account across the core/amp mix, respecting the buffer', () => {
    const { picks } = screen([NVDA, TQQQ], cfg);
    const { entries } = planEntries({ equity: 100, settledCash: 100, openPositions: [], picks }, cfg);
    assert.ok(entries.length >= 1 && entries.length <= cfg.sizing.maxPositions);
    const total = entries.reduce((s, e) => s + e.usd, 0);
    assert.ok(total <= 95 + 0.01, `deployed ${total} must respect the 5% cash buffer`);
    // Both tiers are fractional → market orders.
    for (const e of entries) assert.equal(e.orderType, 'market');
  });

  test('respects the 40% max-position cap', () => {
    const { picks } = screen([NVDA, TQQQ], cfg);
    const { entries } = planEntries({ equity: 100, settledCash: 100, openPositions: [], picks }, cfg);
    for (const e of entries) assert.ok(e.usd <= 40 + 0.01, `${e.symbol} ${e.usd} <= 40% cap`);
  });

  test('deploys only settled cash (GFV guard)', () => {
    const { picks } = screen([NVDA, TQQQ], cfg);
    const { entries } = planEntries({ equity: 100, settledCash: 10, openPositions: [], picks }, cfg);
    const total = entries.reduce((s, e) => s + e.usd, 0);
    assert.ok(total <= 10, `only settled cash deployable, got ${total}`);
  });

  test('no free slots → no entries', () => {
    const open = Array.from({ length: cfg.sizing.maxPositions }, (_, i) => ({ symbol: `S${i}`, tier: 'core' }));
    const { picks } = screen([NVDA], cfg);
    assert.equal(planEntries({ equity: 100, settledCash: 100, openPositions: open, picks }, cfg).entries.length, 0);
  });

  test('does not re-buy a held symbol', () => {
    const { picks } = screen([NVDA, TQQQ], cfg);
    const { entries } = planEntries(
      { equity: 100, settledCash: 100, openPositions: [{ symbol: 'NVDA', tier: 'core' }], picks }, cfg);
    assert.ok(!entries.some(e => e.symbol === 'NVDA'));
  });
});
