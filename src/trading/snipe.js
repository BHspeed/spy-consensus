/**
 * SPY turn "snipe" — the value-flip option scalp trigger, BIDIRECTIONAL.
 *
 * Snipes a sharp intraday TURN in either direction and scalps the pop in the
 * contract's value (see consensus/valueFlip.js for the exit — ride it, trail the
 * peak, bank on the flip):
 *   - bullish turn (dip → up)   → buy a CALL
 *   - bearish turn (peak → down) → buy a PUT
 *
 * It snipes the turn, not raw momentum, so it isn't chasing a move that already
 * ran. detectSignal() is pure: the live agent pulls recent SPY 5-min closes and
 * this decides. The ACCOUNT is the master gate — the caller must NOT snipe when
 * the daily-loss stop is active (a big red day is no time to recover-trade).
 *
 * @param {number[]} closes  recent SPY intraday closes, oldest→newest (5-min)
 * @param {Object}   cfg
 * @returns {{signal:boolean, direction:'call'|'put'|null, roc:number, reason:string}}
 */
export function detectSignal(closes, cfg) {
  const r = cfg.snipe.reversal;
  if (!cfg.snipe.enabled) return { signal: false, direction: null, roc: 0, reason: 'snipe disabled' };
  if (!closes || closes.length < r.lookbackBars) return { signal: false, direction: null, roc: 0, reason: 'not enough bars' };

  const recent = closes.slice(-r.lookbackBars);
  const last = recent[recent.length - 1];
  const ref = recent[recent.length - 3] ?? recent[0];   // ~2 bars ago
  const roc = round2(((last - ref) / ref) * 100);
  const lowIdx = recent.indexOf(Math.min(...recent));
  const highIdx = recent.indexOf(Math.max(...recent));

  // Bullish: the low was before the last two bars, and price is now rising.
  const dipThenUp = lowIdx <= recent.length - 3 && last > recent[recent.length - 2];
  // Bearish: the high was before the last two bars, and price is now falling.
  const peakThenDown = highIdx <= recent.length - 3 && last < recent[recent.length - 2];

  if (dipThenUp && roc >= r.upRocPct) {
    return { signal: true, direction: 'call', roc, reason: `bullish turn: dip→up, last-2-bar ROC +${roc}% — snipe a CALL.` };
  }
  if (peakThenDown && roc <= -r.upRocPct) {
    return { signal: true, direction: 'put', roc, reason: `bearish turn: peak→down, last-2-bar ROC ${roc}% — snipe a PUT.` };
  }
  return { signal: false, direction: null, roc, reason: `no snipe: ROC ${roc}%, no clean turn (need |ROC| ≥ ${r.upRocPct}%).` };
}

function round2(v) { return Math.round(v * 100) / 100; }
