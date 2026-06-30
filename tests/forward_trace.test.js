import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDay, summarizeTraces } from '../src/consensus/forwardTrace.js';

describe('forward trace — evaluateDay', () => {
  test('UP that runs up → RIGHT and scalpable', () => {
    const d = evaluateDay({ predictedDir: 'UP', confidence: 69, open: 741, midday: 743, high: 745, low: 740, close: 744 });
    assert.equal(d.verdict, 'RIGHT');
    assert.equal(d.hitByClose, true);
    assert.equal(d.scalpablePop, true);
    assert.ok(d.mfePct > 0.4 && d.maePct < 0);
  });

  test('UP that pops then fades → WRONG by close but STILL scalpable', () => {
    // peaked +0.27% (scalpable) but closed -0.54%
    const d = evaluateDay({ predictedDir: 'UP', confidence: 60, open: 741, high: 743, low: 736, close: 737 });
    assert.equal(d.verdict, 'WRONG');
    assert.equal(d.scalpablePop, true); // a scalp would have worked even though it closed red
  });

  test('UP that never pops → WRONG and not scalpable', () => {
    const d = evaluateDay({ predictedDir: 'UP', confidence: 55, open: 741, high: 741.3, low: 736, close: 737 });
    assert.equal(d.scalpablePop, false);
  });

  test('DOWN that drops → RIGHT', () => {
    const d = evaluateDay({ predictedDir: 'DOWN', confidence: 64, open: 741, high: 742, low: 735, close: 736 });
    assert.equal(d.verdict, 'RIGHT');
    assert.ok(d.mfePct > 0.5);
    assert.equal(d.scalpablePop, true);
  });

  test('SIDEWAYS → NO-TRADE, no scoring', () => {
    const d = evaluateDay({ predictedDir: 'SIDEWAYS', confidence: 30, open: 741, high: 742, low: 740, close: 741 });
    assert.equal(d.verdict, 'NO-TRADE');
    assert.equal(d.scalpablePop, null);
  });
});

describe('forward trace — summarizeTraces', () => {
  test('aggregates hit-rate, scalpable-rate and confidence buckets', () => {
    const days = [
      evaluateDay({ predictedDir: 'UP', confidence: 70, open: 100, high: 101, low: 99.8, close: 100.7 }),   // RIGHT, scalpable
      evaluateDay({ predictedDir: 'UP', confidence: 62, open: 100, high: 100.3, low: 99, close: 99.4 }),     // WRONG, scalpable (popped +0.3)
      evaluateDay({ predictedDir: 'DOWN', confidence: 50, open: 100, high: 100.1, low: 99.9, close: 100.0 }),// FLAT
      evaluateDay({ predictedDir: 'SIDEWAYS', confidence: 30, open: 100, high: 100.2, low: 99.8, close: 100 }), // excluded
    ];
    const s = summarizeTraces(days);
    assert.equal(s.days, 3);            // SIDEWAYS excluded
    assert.equal(s.right, 1);
    assert.equal(s.wrong, 1);
    assert.equal(s.closedRightPct, 50); // 1 of (1 right + 1 wrong)
    assert.ok(s.scalpablePct >= 60);    // 2 of 3 scored days popped
    assert.ok(s.byConfidence['60-75'].n >= 1);
  });
});
