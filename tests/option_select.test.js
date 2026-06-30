/**
 * Tests for the option-selection layer. Pure — synthetic chains, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectTrades, fromRobinhood } from '../src/consensus/optionSelect.js';

const call = (strike, delta, mark, extra = {}) => ({
  type: 'call', strike, delta, mark,
  bid: mark - 0.02, ask: mark + 0.02, iv: 0.18,
  oi: 5000, volume: 8000, breakeven: strike + mark, popLong: Math.max(0.05, delta - 0.15),
  ...extra,
});
const put = (strike, delta, mark) => ({ ...call(strike, -delta, mark), type: 'put', breakeven: strike - mark });

const upVerdict = { bias: 'UP', side: 'LONG_CALLS', confidence: 70, lastPrice: 740 };
const chain = [call(736, 0.66, 7.0), call(740, 0.52, 4.6), call(742, 0.44, 3.4), call(745, 0.34, 2.1), call(750, 0.18, 0.9)];

describe('option selector', () => {
  test('NEUTRAL → stand aside, no candidates', () => {
    const r = selectTrades({ bias: 'NEUTRAL', side: 'STAND_ASIDE', confidence: 30 }, chain);
    assert.equal(r.standAside, true);
    assert.equal(r.candidates.length, 0);
  });

  test('UP → only calls, ranked by confidence desc', () => {
    const r = selectTrades(upVerdict, chain);
    assert.ok(r.candidates.length > 0);
    assert.ok(r.candidates.every(c => c.legs.every(l => l.type === 'call')));
    for (let i = 1; i < r.candidates.length; i++) {
      assert.ok(r.candidates[i - 1].confidence >= r.candidates[i].confidence);
    }
  });

  test('produces both long singles and debit verticals', () => {
    const r = selectTrades(upVerdict, chain);
    assert.ok(r.candidates.some(c => c.kind === 'long_single'));
    assert.ok(r.candidates.some(c => c.kind === 'debit_vertical'));
  });

  test('excludes far-OTM low-delta strikes from long singles', () => {
    const r = selectTrades(upVerdict, chain);
    // 0.18-delta 750 call is below the 0.35 floor → no long single for it
    assert.ok(!r.candidates.some(c => c.kind === 'long_single' && c.structure.includes('750')));
  });

  test('DOWN verdict selects puts', () => {
    const dn = { bias: 'DOWN', side: 'LONG_PUTS', confidence: 65, lastPrice: 740 };
    const puts = [put(744, 0.66, 7), put(740, 0.52, 4.6), put(738, 0.44, 3.4), put(735, 0.33, 2)];
    const r = selectTrades(dn, puts);
    assert.ok(r.candidates.length > 0);
    assert.ok(r.candidates.every(c => c.legs.every(l => l.type === 'put')));
  });

  test('UP with puts present → produces a put credit spread (sell-side)', () => {
    const withPuts = [...chain, put(737, 0.36, 2.6), put(735, 0.30, 2.0), put(733, 0.24, 1.5)];
    const r = selectTrades(upVerdict, withPuts);
    const credit = r.candidates.find(c => c.kind === 'credit_vertical');
    assert.ok(credit, 'should produce a credit vertical');
    assert.ok(credit.legs.every(l => l.type === 'put'));
    assert.equal(credit.legs[0].action, 'SELL');
    assert.equal(credit.legs[1].action, 'BUY');
    assert.ok(credit.credit > 0 && credit.maxLoss > 0);
  });

  test('confidence is bounded 0..95', () => {
    const r = selectTrades(upVerdict, chain);
    assert.ok(r.candidates.every(c => c.confidence >= 0 && c.confidence <= 95));
  });

  test('fromRobinhood maps fields', () => {
    const c = fromRobinhood('740.0000', 'call', {
      mark_price: '5.18', bid_price: '5.12', ask_price: '5.24', delta: '0.540',
      implied_volatility: '0.179', open_interest: 7392, volume: 23974,
      break_even_price: '745.18', chance_of_profit_long: '0.359',
    });
    assert.equal(c.strike, 740);
    assert.equal(c.mark, 5.18);
    assert.equal(c.delta, 0.54);
    assert.equal(c.popLong, 0.359);
  });
});
