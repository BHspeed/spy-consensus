import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/consensus/logStats.js';

const run = (t, dir, conf, spot, decision = 'IDEAS') =>
  ({ loggedAt: t, decision, spot, consensus: { dir, score: 0, confidence: conf } });
const trade = (structure, pnl, status = 'closed') => ({ type: 'trade', structure, pnl, status });

describe('log summary', () => {
  test('counts runs, decisions and direction mix', () => {
    const s = summarize([
      run('2026-06-29T14:00:00Z', 'UP', 70, 740),
      run('2026-06-29T18:00:00Z', 'SIDEWAYS', 30, 741, 'STAND_ASIDE'),
      run('2026-06-30T14:00:00Z', 'DOWN', 60, 738),
    ]);
    assert.equal(s.runs.total, 3);
    assert.equal(s.runs.ideas, 2);
    assert.equal(s.runs.standAside, 1);
    assert.equal(s.runs.byDir.UP, 1);
    assert.equal(s.runs.byDir.DOWN, 1);
  });

  test('direction hit-rate uses move to the next logged spot', () => {
    const s = summarize([
      run('2026-06-29T14:00:00Z', 'UP', 70, 740),   // next spot 744 → up → right
      run('2026-06-29T18:00:00Z', 'UP', 65, 744),   // next spot 742 → down → wrong
      run('2026-06-30T14:00:00Z', 'UP', 60, 742),   // no next → skipped
    ]);
    assert.equal(s.direction.right, 1);
    assert.equal(s.direction.wrong, 1);
    assert.equal(s.direction.hitRatePct, 50);
  });

  test('trade win-rate and P&L, split by structure', () => {
    const s = summarize([
      trade('DEBIT 741/745C', 112),
      trade('DEBIT 740/743C', -176),
      trade('CREDIT 736/733P', 38),
    ]);
    assert.equal(s.trades.closed, 3);
    assert.equal(s.trades.wins, 2);
    assert.equal(s.trades.winRatePct, 66.7);
    assert.equal(s.trades.totalPnl, -26);
    assert.equal(s.trades.byStructure.debit.n, 2);
    assert.equal(s.trades.byStructure.credit.n, 1);
    assert.equal(s.trades.best.pnl, 112);
    assert.equal(s.trades.worst.pnl, -176);
  });

  test('empty / ideas-only log is graceful', () => {
    const s = summarize([run('2026-06-29T14:00:00Z', 'UP', 69, 741)]);
    assert.equal(s.trades.closed, 0);
    assert.equal(s.direction.comparable, 0);
  });
});
