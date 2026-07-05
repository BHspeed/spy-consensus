/**
 * Leveraged-ETF swing grading — self-scores the channel's buy-the-dip calls.
 *
 * RIGHT = the ETF's high reached the bounce target; WRONG = its low hit the stop
 * first; FLAT = neither within the hold window (~3 weeks). Graded from the ETF's
 * own high/low since entry — we hold the ETF, so its price IS the P&L (no
 * delta-inference needed, unlike the weekly options grade).
 */
const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const HOLD_MAX_DAYS = 21;

export function gradeLevPick(pick, md, todayISO) {
  const daysHeld = Math.max(0, days(pick.added, todayISO));
  const hitTarget = md.high >= pick.target;
  const stopped = md.low <= pick.stop;
  let verdict = null;
  let closed = false;
  if (hitTarget) { verdict = 'RIGHT'; closed = true; }
  else if (stopped) { verdict = 'WRONG'; closed = true; }
  else if (daysHeld >= HOLD_MAX_DAYS) { verdict = 'FLAT'; closed = true; }
  return { ...pick, daysHeld, high: md.high, low: md.low, verdict, closed, status: closed ? 'closed' : 'open' };
}

export function summarizeLev(records) {
  const g = (records || []).filter((r) => r.status === 'closed' && r.verdict);
  const right = g.filter((r) => r.verdict === 'RIGHT').length;
  const wrong = g.filter((r) => r.verdict === 'WRONG').length;
  const flat = g.filter((r) => r.verdict === 'FLAT').length;
  return { graded: g.length, right, wrong, flat, hitRatePct: pctOf(right, right + wrong) };
}
