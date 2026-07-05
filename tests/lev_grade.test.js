import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLevPick, summarizeLev } from '../src/strategies/levetf/levGrade.js';

const pick = (o = {}) => ({ etf: 'X', added: '2026-06-01', entry: 10, target: 11.5, stop: 9, ...o });

describe('leveraged ETF grade', () => {
  test('RIGHT when the ETF high reaches the bounce target', () => {
    assert.equal(gradeLevPick(pick(), { high: 11.6, low: 9.4 }, '2026-06-10').verdict, 'RIGHT');
  });
  test('WRONG when it hits the stop', () => {
    assert.equal(gradeLevPick(pick(), { high: 10.6, low: 8.9 }, '2026-06-06').verdict, 'WRONG');
  });
  test('FLAT after ~3 weeks with no bounce or stop', () => {
    const g = gradeLevPick(pick(), { high: 11, low: 9.3 }, '2026-06-25');
    assert.equal(g.verdict, 'FLAT');
    assert.ok(g.closed);
  });
  test('still open before target/stop/expiry', () => {
    const g = gradeLevPick(pick(), { high: 11, low: 9.3 }, '2026-06-10');
    assert.equal(g.verdict, null);
    assert.equal(g.status, 'open');
  });
  test('summarizeLev counts R/W/F + hit-rate', () => {
    const s = summarizeLev([
      { status: 'closed', verdict: 'RIGHT' }, { status: 'closed', verdict: 'RIGHT' },
      { status: 'closed', verdict: 'WRONG' }, { status: 'closed', verdict: 'FLAT' }, { status: 'open' },
    ]);
    assert.equal(s.graded, 4);
    assert.equal(s.right, 2);
    assert.equal(s.hitRatePct, 66.7); // 2 of (2+1)
  });
});
