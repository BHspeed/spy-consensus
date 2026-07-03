import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eventFor, isReportDay } from '../src/consensus/econEvents.js';
import { summarizeTraces } from '../src/consensus/forwardTrace.js';

describe('econ events', () => {
  test('override wins over the rule', () => {
    assert.equal(eventFor('2026-07-02', { '2026-07-02': 'NFP jobs report' }), 'NFP jobs report');
  });
  test('first Friday of month is inferred as NFP', () => {
    assert.equal(eventFor('2026-08-07'), 'NFP jobs report'); // Aug 7 2026 is the first Friday
    assert.ok(isReportDay('2026-08-07'));
  });
  test('a normal weekday is not a report day', () => {
    assert.equal(eventFor('2026-08-12'), null);
    assert.equal(isReportDay('2026-08-12'), false);
  });
});

describe('scorecard segments by day type', () => {
  const traces = [
    { type: 'trace', date: '2026-06-30', verdict: 'RIGHT', confidence: 70, mfePct: 0.5, scalpablePop: true },
    { type: 'trace', date: '2026-07-01', verdict: 'RIGHT', confidence: 68, mfePct: 0.4, scalpablePop: true },
    { type: 'trace', date: '2026-07-02', verdict: 'WRONG', confidence: 78, mfePct: 0.0, scalpablePop: false, event: 'NFP jobs report' },
  ];
  test('normal vs report cohorts are separated', () => {
    const s = summarizeTraces(traces);
    assert.equal(s.byDayType.normal.days, 2);
    assert.equal(s.byDayType.normal.closedRightPct, 100);
    assert.equal(s.byDayType.report.days, 1);
    assert.equal(s.byDayType.report.right, 0);
    assert.equal(s.byDayType.report.closedRightPct, 0);
  });
});
