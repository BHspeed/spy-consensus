/**
 * Forward trace — cross-reference the morning consensus against what price
 * actually did, so we learn whether the call verified AND (most important for a
 * scalper) whether there was a poppable move in the predicted direction even on
 * days the close went nowhere.
 *
 * Pure: takes prices in, returns the evaluation. No I/O.
 *
 * A "day" capture: { predictedDir:'UP'|'DOWN'|'SIDEWAYS', confidence,
 *                    open, midday, high, low, close }   (prices in $)
 * Baseline is the OPEN (≈ the 9:45 consensus spot). MFE = max favorable
 * excursion in the predicted direction; MAE = max adverse.
 */

// A move of this % in the predicted direction is enough to scalp a near-ATM
// option's value (a few SPY points → ~+20-30% on the contract).
export const SCALP_THRESHOLD_PCT = 0.25;
const r2 = (v) => Math.round(v * 100) / 100;

export function evaluateDay(day) {
  const { predictedDir, confidence, open, midday, high, low, close } = day;
  const base = open;
  const pct = (p) => (base ? ((p - base) / base) * 100 : 0);

  const middayMovePct = midday != null ? r2(pct(midday)) : null;
  const closeMovePct = r2(pct(close));

  let mfePct, maePct, hitByClose, verdict;
  if (predictedDir === 'UP') {
    mfePct = r2(pct(high));        // how far up it ran
    maePct = r2(pct(low));         // how far down it went (against)
    hitByClose = closeMovePct > 0.05;
  } else if (predictedDir === 'DOWN') {
    mfePct = r2(-pct(low));        // favorable = down, so flip sign
    maePct = r2(-pct(high));
    hitByClose = closeMovePct < -0.05;
  } else {
    // SIDEWAYS / no-trade — just record, no scoring
    return {
      ...day, predictedDir, middayMovePct, closeMovePct,
      mfePct: null, maePct: null, hitByClose: null, scalpablePop: null, verdict: 'NO-TRADE',
      note: `no-trade day (${predictedDir}); SPY moved ${closeMovePct}% open→close.`,
    };
  }

  const scalpablePop = mfePct >= SCALP_THRESHOLD_PCT;
  if (Math.abs(closeMovePct) <= 0.05) verdict = 'FLAT';
  else verdict = hitByClose ? 'RIGHT' : 'WRONG';

  const note = `${predictedDir} ${confidence}% → close ${closeMovePct >= 0 ? '+' : ''}${closeMovePct}% (${verdict}); `
    + `peak ${mfePct >= 0 ? '+' : ''}${mfePct}% in-dir ${scalpablePop ? '✓ scalpable' : 'too small'}, worst ${maePct}%.`;

  return { ...day, predictedDir, middayMovePct, closeMovePct, mfePct, maePct, hitByClose, scalpablePop, verdict, note };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Aggregate over many evaluated days → the learning scorecard. */
export function summarizeTraces(records) {
  const traces = records.filter(t => t && t.verdict && t.verdict !== 'NO-TRADE');
  const directional = traces.filter(t => t.verdict !== 'FLAT' || t.mfePct != null);
  const scored = traces.filter(t => t.mfePct != null);

  const right = traces.filter(t => t.verdict === 'RIGHT').length;
  const wrong = traces.filter(t => t.verdict === 'WRONG').length;
  const flat = traces.filter(t => t.verdict === 'FLAT').length;
  const scalpable = scored.filter(t => t.scalpablePop).length;

  const bucket = (lo, hi) => {
    const b = scored.filter(t => t.confidence >= lo && t.confidence < hi);
    return {
      n: b.length,
      closedRightPct: pctOf(b.filter(t => t.verdict === 'RIGHT').length, b.length),
      scalpablePct: pctOf(b.filter(t => t.scalpablePop).length, b.length),
      avgMfe: r2(avg(b.map(t => t.mfePct))),
    };
  };

  return {
    days: traces.length,
    closedRightPct: pctOf(right, right + wrong),
    right, wrong, flat,
    scalpablePct: pctOf(scalpable, scored.length),  // had a poppable in-dir move
    avgMfe: r2(avg(scored.map(t => t.mfePct))),
    avgMae: r2(avg(scored.map(t => t.maePct))),
    byConfidence: { '45-60': bucket(45, 60), '60-75': bucket(60, 75), '75-100': bucket(75, 101) },
  };
}
