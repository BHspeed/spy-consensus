/**
 * Swing-pick grading — the longer-horizon self-grader for strategy #2.
 *
 * Unlike the SPY forward-trace (graded same-day), swing picks are held 20-30
 * days, so they get a WEEKLY progress check and a FINAL report when the hold
 * window closes (target hit, stopped out, or ~month elapsed). Peak favorable
 * move (MFE) matters: a swing that spikes to target then fades still counts as
 * a hit, because the plan is to take the target.
 *
 * Pure: give it a pick + its market data since entry; it returns the grade.
 * pick   = { symbol, added, entry, tier, targetPct, targetPrice, stopPrice }
 * md     = { last, highSince, lowSince }   (highSince/lowSince optional)
 */
const r1 = (v) => Math.round(v * 10) / 10;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function gradePick(pick, md, todayISO) {
  const daysHeld = Math.max(0, days(pick.added, todayISO));
  const last = md.last;
  const gainPct = r1(((last - pick.entry) / pick.entry) * 100);
  const mfePct = md.highSince != null ? r1(((md.highSince - pick.entry) / pick.entry) * 100) : null;
  const maePct = md.lowSince != null ? r1(((md.lowSince - pick.entry) / pick.entry) * 100) : null;

  const hitTarget = md.highSince != null ? md.highSince >= pick.targetPrice : last >= pick.targetPrice;
  const stopped = md.lowSince != null ? md.lowSince <= pick.stopPrice : last <= pick.stopPrice;

  let status, verdict, closed = false, realizedPct = null;
  if (hitTarget) {
    status = 'hit'; closed = true; realizedPct = pick.targetPct; // exit at target
    verdict = `🎯 HIT TARGET (+${pick.targetPct}%) in ${daysHeld}d`;
  } else if (stopped) {
    status = 'stopped'; closed = true; realizedPct = -pick.stopPct;
    verdict = `⛔ stopped out (-${pick.stopPct}%) in ${daysHeld}d`;
  } else if (daysHeld >= 28) {
    status = 'expired'; closed = true; realizedPct = gainPct;
    verdict = `⏱ closed at ${gainPct >= 0 ? '+' : ''}${gainPct}%${mfePct != null ? ` (peaked +${mfePct}%)` : ''}`;
  } else {
    status = 'open';
    const wk = Math.max(1, Math.ceil(daysHeld / 7));
    const toTarget = r1(((pick.targetPrice - last) / last) * 100);
    verdict = `wk${wk} · ${gainPct >= 0 ? '+' : ''}${gainPct}%${mfePct != null ? ` (peak +${mfePct}%)` : ''} · ${toTarget}% to target`;
  }
  return { ...pick, daysHeld, last, gainPct, mfePct, maePct, status, verdict, closed, realizedPct };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Aggregate scorecard over CLOSED swing picks. */
export function summarizeSwings(closed) {
  const done = closed.filter((p) => p.status && p.status !== 'open');
  const hits = done.filter((p) => p.status === 'hit');
  const byTier = {};
  for (const p of done) {
    const t = p.tier || 'core';
    (byTier[t] ||= { n: 0, hits: 0, gain: [], mfe: [] });
    byTier[t].n++; if (p.status === 'hit') byTier[t].hits++;
    const realized = typeof p.realizedPct === 'number' ? p.realizedPct : p.gainPct;
    if (typeof realized === 'number') byTier[t].gain.push(realized);
    if (typeof p.mfePct === 'number') byTier[t].mfe.push(p.mfePct);
  }
  for (const t of Object.keys(byTier)) {
    byTier[t].hitRate = pct(byTier[t].hits, byTier[t].n);
    byTier[t].avgGain = r1(avg(byTier[t].gain));
    byTier[t].avgPeak = r1(avg(byTier[t].mfe));
  }
  return {
    closed: done.length,
    hitRate: pct(hits.length, done.length),
    stopped: done.filter((p) => p.status === 'stopped').length,
    expired: done.filter((p) => p.status === 'expired').length,
    avgGain: r1(avg(done.map((p) => (typeof p.realizedPct === 'number' ? p.realizedPct : p.gainPct)).filter((x) => typeof x === 'number'))),
    avgPeak: r1(avg(done.map((p) => p.mfePct).filter((x) => typeof x === 'number'))),
    byTier,
  };
}
