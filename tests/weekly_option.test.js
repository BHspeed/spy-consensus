import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreWeekly, selectWeeklies } from '../src/strategies/weeklies/weeklyOption.js';

const call = (o = {}) => ({ symbol: 'SPY', type: 'call', strike: 746, expiry: '2026-07-10', dte: 3, mark: 2.95, bid: 2.9, ask: 3.0, delta: 0.45, gamma: 0.032, open_interest: 10000, volume: 8000, ...o });
const ctx = { spot: 745, expectedMovePct: 0.5, dir: 'UP' };

describe('weekly value-flip selector', () => {
  test('a near-ATM liquid weekly qualifies with 10%+ value flip', () => {
    const s = scoreWeekly(call(), ctx);
    assert.ok(s.qualifies);
    assert.ok(s.valueFlipPct >= 10);
    assert.equal(s.plan.take, 3.54);   // +20%
    assert.equal(s.plan.stop, 2.36);   // -20%
  });

  test('low-delta lottery ticket is rejected', () => {
    const s = scoreWeekly(call({ strike: 752, delta: 0.14, mark: 0.65, bid: 0.62, ask: 0.68 }), ctx);
    assert.equal(s.qualifies, false);
  });

  test('wide-spread / illiquid is rejected', () => {
    const s = scoreWeekly(call({ bid: 2.5, ask: 3.4, open_interest: 50, volume: 10 }), ctx);
    assert.equal(s.qualifies, false);
  });

  test('picks calls for UP, puts for DOWN', () => {
    assert.equal(scoreWeekly(call({ type: 'put', delta: -0.45 }), ctx), null); // put ignored when UP
    const down = scoreWeekly(call({ type: 'put', delta: -0.45 }), { ...ctx, dir: 'DOWN' });
    assert.ok(down && down.type === 'put');
  });

  test('selectWeeklies ranks the sweet spot ahead of deep-ITM', () => {
    const chain = [
      call({ strike: 742, delta: 0.63, mark: 5.2, bid: 5.1, ask: 5.3 }),   // deep ITM, low leverage
      call({ strike: 746, delta: 0.45, mark: 2.95 }),                       // sweet spot
    ];
    const picks = selectWeeklies(chain, ctx, 2);
    assert.equal(picks[0].strike, 746);
  });
});
