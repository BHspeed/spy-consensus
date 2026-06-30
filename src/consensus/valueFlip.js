/**
 * Value-flip exit manager.
 *
 * Implements "take profits off value flips, not strike hits": the decision is
 * driven entirely by the OPTION'S MARK over time — never its strike, intrinsic
 * value, or distance to expiry. You ride the contract while its value is rising
 * and bank the move the moment it flips down off a profitable peak.
 *
 * Usage: track the option's mark since entry in `marks` (most recent last),
 * then call decideExit() on each update.
 */

export const DEFAULT_CONFIG = {
  minProfitPct: 25,   // peak gain must reach this % off entry before a trail can fire
  trailPct: 30,       // exit after giving back this % OF THE PEAK GAIN (not of price)
  stopPct: 35,        // hard stop: exit if mark is down this % from entry
  hardTakePct: 120,   // always bank if up this much (a "value flip" we won't risk)
};

/**
 * SCALP preset — the house style: bank the value pop fast, don't wait to be
 * 100% right. Arms on small gains, trails tight, stops tight, takes a quick rip
 * outright. Use this for the live monitor; DEFAULT_CONFIG is the patient/swing
 * variant.
 */
export const SCALP_CONFIG = {
  minProfitPct: 12,   // arm fast — a small pop is enough
  trailPct: 25,       // give back only a quarter of the peak gain, then out
  stopPct: 25,        // tight stop — small losses, get back in
  hardTakePct: 50,    // bank a +50% rip outright
};

/**
 * @param {number} entryMark      premium paid/received per share at entry (>0)
 * @param {number[]} marks        series of marks since entry, most recent last
 * @param {object} [opts]
 * @param {boolean} [opts.consensusFlipped]  consensus now opposes the position
 * @param {object} [opts.config]
 * @returns {{action:'HOLD'|'TAKE_PROFIT'|'STOP_OUT'|'EXIT_SIGNAL', reason:string, gainPct:number, peakGainPct:number}}
 */
export function decideExit(entryMark, marks, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  if (!entryMark || entryMark <= 0) throw new Error('entryMark must be > 0');
  if (!marks || marks.length === 0) throw new Error('marks must be a non-empty array');

  const curr = marks[marks.length - 1];
  const peak = Math.max(...marks);
  const gainPct = round1(((curr - entryMark) / entryMark) * 100);
  const peakGainPct = round1(((peak - entryMark) / entryMark) * 100);
  // How much of the PEAK GAIN has been handed back (the "value flip").
  const givebackPct = peakGainPct > 0 ? round1(((peakGainPct - gainPct) / peakGainPct) * 100) : 0;

  // Consensus turning against an open position overrides everything.
  if (opts.consensusFlipped) {
    return mk('EXIT_SIGNAL', `Consensus flipped against the position — exit (gain ${gainPct}%).`, gainPct, peakGainPct);
  }
  // Lock in an outsized win regardless of trail.
  if (gainPct >= cfg.hardTakePct) {
    return mk('TAKE_PROFIT', `Up ${gainPct}% — banking the move (hard take ≥ ${cfg.hardTakePct}%).`, gainPct, peakGainPct);
  }
  // Hard stop on bleed.
  if (gainPct <= -cfg.stopPct) {
    return mk('STOP_OUT', `Down ${gainPct}% — hard stop at -${cfg.stopPct}%.`, gainPct, peakGainPct);
  }
  // The core "value flip": was profitable, now handing back the gain off the peak.
  if (peakGainPct >= cfg.minProfitPct && givebackPct >= cfg.trailPct) {
    return mk('TAKE_PROFIT',
      `Value flip: peaked +${peakGainPct}%, gave back ${givebackPct}% of it to +${gainPct}% — take profit.`,
      gainPct, peakGainPct);
  }
  return mk('HOLD',
    `Hold — gain ${gainPct}%, peak +${peakGainPct}%, gave back ${givebackPct}% (fires at +${cfg.minProfitPct}% peak & ${cfg.trailPct}% giveback).`,
    gainPct, peakGainPct);
}

function mk(action, reason, gainPct, peakGainPct) { return { action, reason, gainPct, peakGainPct }; }
function round1(v) { return Math.round(v * 10) / 10; }
