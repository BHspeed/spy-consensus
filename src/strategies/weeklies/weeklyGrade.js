/**
 * Weekly value-flip grading — self-scores the channel's own callouts, R/W/F.
 *
 * A callout is RIGHT if the premium flipped +10% (i.e. the underlying made the
 * small favorable move that gets us there), WRONG if it hit the -20% stop first,
 * FLAT otherwise. Robinhood has no option-history tool, so we infer the premium
 * move from the underlying's high/low using the entry delta (delta-linear, with
 * the same 0.6 realism haircut the selector uses):
 *   premium +10% needs an underlying move of  mark / (6 * delta)
 *   premium -20% needs an underlying move of  mark / (3 * delta)
 * Those trigger prices are stamped on each pick at callout, so grading is a
 * simple high/low check.
 */
const r1 = (v) => Math.round(v * 10) / 10;
const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Underlying trigger prices for a pick, computed at callout time. */
export function flipTriggers({ type, entrySpot, entryMark, delta }) {
  const d = Math.abs(delta) || 0.01;
  const flipMove = entryMark / (6 * d);
  const stopMove = entryMark / (3 * d);
  const call = type === 'call';
  return {
    flipUnderlying: r1(call ? entrySpot + flipMove : entrySpot - flipMove),
    stopUnderlying: r1(call ? entrySpot - stopMove : entrySpot + stopMove),
  };
}

/** Grade one pick against the underlying's high/low over the hold. */
export function gradeWeeklyPick(pick, md) {
  const call = pick.type === 'call';
  const flipped = call ? md.high >= pick.flipUnderlying : md.low <= pick.flipUnderlying;
  const stopped = call ? md.low <= pick.stopUnderlying : md.high >= pick.stopUnderlying;
  const verdict = flipped ? 'RIGHT' : stopped ? 'WRONG' : 'FLAT';
  return { ...pick, high: md.high, low: md.low, verdict, status: 'graded' };
}

/** Running record over graded callouts. */
export function summarizeWeeklies(records) {
  const g = (records || []).filter((r) => r.verdict && r.status === 'graded');
  const right = g.filter((r) => r.verdict === 'RIGHT').length;
  const wrong = g.filter((r) => r.verdict === 'WRONG').length;
  const flat = g.filter((r) => r.verdict === 'FLAT').length;
  return { graded: g.length, right, wrong, flat, hitRatePct: pctOf(right, right + wrong) };
}
