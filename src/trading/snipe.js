/**
 * SPY reversal "snipe" — the value-flip option scalp trigger.
 *
 * Waits for SPY to turn UP off an intraday dip (a bounce), which is the entry the
 * account owner wants: buy a cheap near-dated OTM call and scalp the pop in the
 * contract's VALUE, then bank it on the flip (see valueFlip.js for the exit).
 * We're sniping the move, not betting on being right long-term.
 *
 * detectReversal() is pure: the live agent pulls recent SPY 5-min closes + whether
 * SPY is below its 10-day EMA (i.e. in a dip worth bouncing), and this decides.
 * Contract selection reuses optionPlan.selectOption with the `snipe` config; the
 * exit reuses valueFlip.decideExit on the option mark.
 *
 * @param {number[]} closes   recent SPY intraday closes, oldest→newest (5-min)
 * @param {boolean}  belowEma is SPY below its 10-day EMA right now?
 * @param {Object}   cfg
 * @returns {{signal:boolean, upRoc:number, reason:string}}
 */
export function detectReversal(closes, belowEma, cfg) {
  const r = cfg.snipe.reversal;
  if (!cfg.snipe.enabled) return { signal: false, upRoc: 0, reason: 'snipe disabled' };
  if (!closes || closes.length < r.lookbackBars) return { signal: false, upRoc: 0, reason: 'not enough bars' };

  const recent = closes.slice(-r.lookbackBars);
  const last = recent[recent.length - 1];
  const ref = recent[recent.length - 3] ?? recent[0];       // ~2 bars ago
  const upRoc = round2(((last - ref) / ref) * 100);

  // A dip THEN an up-flip: the lookback low must be before the last two bars, and
  // the last two bars must be rising.
  const lowIdx = recent.indexOf(Math.min(...recent));
  const dipThenUp = lowIdx <= recent.length - 3 && last > recent[recent.length - 2];
  const belowOk = !r.requireBelowEma || belowEma;
  const signal = belowOk && dipThenUp && upRoc >= r.upRocPct;

  return {
    signal,
    upRoc,
    reason: signal
      ? `SPY reversal: bounced off the dip, last-2-bar ROC +${upRoc}%${r.requireBelowEma ? ' (from below 10d-EMA)' : ''} — snipe a call.`
      : `No snipe: ${!belowOk ? 'not in a dip (SPY above EMA)' : !dipThenUp ? 'no dip-then-up structure' : `ROC +${upRoc}% < ${r.upRocPct}%`}.`,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
