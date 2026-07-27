/**
 * Unit tests for the options arm: contract selection, premium management, and
 * the bidirectional direction read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { selectOption, decideOptionExit } from '../src/trading/optionPlan.js';
import { assessDirection } from '../src/trading/regime.js';

const cfg = loadConfig();

// A small synthetic chain for a ~$25 underlying. Budget for a $100 acct is
// min(maxPremiumUsd 45, 30% of equity = $30, buying power) → ~$30, so contracts
// must be cheap. Premiums are per-share (×100 = contract cost).
const chain = [
  { id: 'a', type: 'call', strike: 25, expiration: '2026-07-31', dte: 4, delta: 0.55, ask: 0.28, mark: 0.27, openInterest: 1200, volume: 300 }, // $28
  { id: 'b', type: 'call', strike: 27, expiration: '2026-07-31', dte: 4, delta: 0.30, ask: 0.15, mark: 0.14, openInterest: 800, volume: 100 },  // OTM, low delta
  { id: 'c', type: 'call', strike: 24, expiration: '2026-07-31', dte: 4, delta: 0.70, ask: 0.90, mark: 0.88, openInterest: 500, volume: 50 },   // delta out of band + too dear
  { id: 'd', type: 'put',  strike: 25, expiration: '2026-07-31', dte: 4, delta: -0.52, ask: 0.25, mark: 0.24, openInterest: 900, volume: 120 }, // $25
];

describe('selectOption', () => {
  test('long → picks an affordable, ATM-ish call in the delta band', () => {
    const r = selectOption({ direction: 'long', underlying: 'FNGU', chain, buyingPower: 68, equity: 100 }, cfg);
    assert.equal(r.consider, true);
    assert.equal(r.contract.id, 'a');       // 0.55Δ, $28, liquid
    assert.ok(r.cost <= 30);
  });

  test('short → picks the put', () => {
    const r = selectOption({ direction: 'short', underlying: 'FNGU', chain, buyingPower: 68, equity: 100 }, cfg);
    assert.equal(r.consider, true);
    assert.equal(r.contract.type, 'put');
  });

  test('rejects when nothing affordable within budget', () => {
    const r = selectOption({ direction: 'long', underlying: 'X', chain, buyingPower: 10, equity: 100 }, cfg);
    // budget = min(45, 30, 10) = 10; the $28 call no longer fits, 'b' is out of the delta band
    assert.equal(r.consider, false);
  });

  test('disabled config → no consideration', () => {
    const off = loadConfig({ options: { ...cfg.options, enabled: false } });
    assert.equal(selectOption({ direction: 'long', underlying: 'X', chain, buyingPower: 68, equity: 100 }, off).consider, false);
  });
});

describe('decideOptionExit', () => {
  test('banks at the premium target', () => {
    assert.equal(decideOptionExit(1.00, 1.55, cfg).action, 'SELL'); // +55% ≥ 50%
  });
  test('stops at the premium stop', () => {
    assert.equal(decideOptionExit(1.00, 0.60, cfg).action, 'SELL'); // -40% ≤ -35%
  });
  test('holds in between', () => {
    assert.equal(decideOptionExit(1.00, 1.20, cfg).action, 'HOLD');
  });
});

describe('assessDirection (bidirectional)', () => {
  test('green + above EMA → long', () => {
    assert.equal(assessDirection({ price: 745, priorClose: 739, ema: 743 }, null, cfg).direction, 'long');
  });
  test('red + below EMA → short', () => {
    assert.equal(assessDirection({ price: 735, priorClose: 739, ema: 743 }, null, cfg).direction, 'short');
  });
  test('green but below EMA → flat (chop, no forced trade)', () => {
    assert.equal(assessDirection({ price: 741.79, priorClose: 738.93, ema: 744.6 }, null, cfg).direction, 'flat');
  });
  test('bearish call-out cancels a long', () => {
    assert.equal(assessDirection({ price: 745, priorClose: 739, ema: 743 }, { bearish: true }, cfg).direction, 'flat');
  });
});
