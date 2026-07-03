import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flipTriggers, gradeWeeklyPick, summarizeWeeklies } from '../src/strategies/weeklies/weeklyGrade.js';

describe('weekly grade', () => {
  test('flipTriggers: call flip above spot, stop below', () => {
    const t = flipTriggers({ type: 'call', entrySpot: 745, entryMark: 2.7, delta: 0.45 });
    assert.ok(t.flipUnderlying > 745);
    assert.ok(t.stopUnderlying < 745);
  });

  test('RIGHT when the underlying makes the flip move', () => {
    const p = { type: 'call', flipUnderlying: 746, stopUnderlying: 743 };
    assert.equal(gradeWeeklyPick(p, { high: 747, low: 744.5 }).verdict, 'RIGHT');
  });

  test('WRONG when it hits the stop and never flips', () => {
    const p = { type: 'call', flipUnderlying: 746, stopUnderlying: 743 };
    assert.equal(gradeWeeklyPick(p, { high: 745.5, low: 742.5 }).verdict, 'WRONG');
  });

  test('FLAT when neither trigger hit', () => {
    const p = { type: 'call', flipUnderlying: 746, stopUnderlying: 743 };
    assert.equal(gradeWeeklyPick(p, { high: 745.5, low: 744 }).verdict, 'FLAT');
  });

  test('put grades on the down side', () => {
    const p = { type: 'put', flipUnderlying: 744, stopUnderlying: 747 };
    assert.equal(gradeWeeklyPick(p, { high: 745, low: 743 }).verdict, 'RIGHT'); // low<=744
    assert.equal(gradeWeeklyPick(p, { high: 748, low: 746 }).verdict, 'WRONG'); // high>=747
  });

  test('summarizeWeeklies counts R/W/F + flip-rate', () => {
    const s = summarizeWeeklies([
      { status: 'graded', verdict: 'RIGHT' }, { status: 'graded', verdict: 'WRONG' },
      { status: 'graded', verdict: 'FLAT' }, { status: 'open' },
    ]);
    assert.equal(s.graded, 3);
    assert.equal(s.right, 1); assert.equal(s.wrong, 1); assert.equal(s.flat, 1);
    assert.equal(s.hitRatePct, 50); // 1 of (1+1)
  });
});
