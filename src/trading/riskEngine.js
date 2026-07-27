/**
 * Risk engine — the money-path logic, kept pure and deterministic so it can be
 * unit-tested and so the live agent never has to "reason" about a stop level.
 *
 * Encodes the house rules:
 *   - initialStop():        3–5% hard stop below entry (per tier).
 *   - updatePositionRisk(): once up >3%, arm a trailing stop that ratchets up.
 *   - decidePositionExit(): HOLD or SELL (initial vs trailing stop hit).
 *   - decideDailyStop():    down 3% on the day → flatten + halt.
 *   - reentryEligible():    can we re-buy a name we were stopped out of?
 *
 * All prices are per-share. All functions are side-effect free: they return
 * updated copies, they never mutate their inputs or touch the clock/network.
 *
 * @typedef {Object} Position
 * @property {string}  symbol
 * @property {'core'|'amp'} tier
 * @property {number}  shares
 * @property {number}  entryPrice
 * @property {number}  entryTime   epoch ms
 * @property {number}  stop        current engine-managed stop price
 * @property {number}  peak        highest price seen since entry
 * @property {boolean} trailArmed  has the +3% trailing stop been armed?
 */

/** Initial hard-stop price for a fresh entry, per tier. */
export function initialStop(entryPrice, tier, cfg) {
  if (!(entryPrice > 0)) throw new Error('entryPrice must be > 0');
  const pct = cfg.risk.initialStopPct[tier];
  if (pct == null) throw new Error(`unknown tier: ${tier}`);
  return round4(entryPrice * (1 - pct / 100));
}

/** Build the position record for a new fill (stop/peak/arm initialised). */
export function openPosition({ symbol, tier, shares, entryPrice, entryTime }, cfg) {
  return {
    symbol,
    tier,
    shares,
    entryPrice: round4(entryPrice),
    entryTime,
    stop: initialStop(entryPrice, tier, cfg),
    peak: round4(entryPrice),
    trailArmed: false,
  };
}

/** Resolve a per-tier risk number (maps like {core, amp}). */
function tierParam(map, tier) {
  const v = map[tier];
  if (v == null) throw new Error(`no risk param for tier: ${tier}`);
  return v;
}

/**
 * Advance a position's trailing state given the latest price. Ratchets the stop
 * UP only — never down. Trail thresholds are per-tier (the amp tier is wider so
 * a 3x ETF isn't shaken out by noise). Returns a new Position; no exit decision.
 */
export function updatePositionRisk(pos, currentPrice, cfg) {
  if (!(currentPrice > 0)) return pos;
  const peak = Math.max(pos.peak, currentPrice);
  const peakGainPct = ((peak - pos.entryPrice) / pos.entryPrice) * 100;

  const armPct = tierParam(cfg.risk.trailArmPct, pos.tier);
  const trailPct = tierParam(cfg.risk.trailPct, pos.tier);
  const lockPct = tierParam(cfg.risk.lockBreakevenAfterPct, pos.tier);

  let trailArmed = pos.trailArmed || peakGainPct >= armPct;
  let stop = pos.stop;

  if (trailArmed) {
    // Trail below the running peak; only ever move the stop higher.
    const trailStop = peak * (1 - trailPct / 100);
    stop = Math.max(stop, trailStop);
    // Once we're up enough, guarantee the stop never sits below break-even.
    if (peakGainPct >= lockPct) {
      stop = Math.max(stop, pos.entryPrice);
    }
  }
  return { ...pos, peak: round4(peak), trailArmed, stop: round4(stop) };
}

/**
 * Decide whether to hold or sell a position at the current price. Updates the
 * trailing state first, then compares price to the (ratcheted) stop.
 * @returns {{action:'HOLD'|'SELL', reason:string, kind:'initial'|'trailing'|null,
 *            gainPct:number, position:Position}}
 */
export function decidePositionExit(pos, currentPrice, cfg) {
  const updated = updatePositionRisk(pos, currentPrice, cfg);
  const gainPct = round2(((currentPrice - updated.entryPrice) / updated.entryPrice) * 100);

  if (currentPrice <= updated.stop) {
    const kind = updated.trailArmed ? 'trailing' : 'initial';
    const reason = kind === 'trailing'
      ? `Trailing stop hit at ${updated.stop} (peak ${updated.peak}, now ${currentPrice}, ${signed(gainPct)}%).`
      : `Initial stop hit at ${updated.stop} (entry ${updated.entryPrice}, now ${currentPrice}, ${signed(gainPct)}%).`;
    return { action: 'SELL', reason, kind, gainPct, position: updated };
  }
  return {
    action: 'HOLD',
    reason: updated.trailArmed
      ? `Hold — trailing (stop ${updated.stop}, peak ${updated.peak}, ${signed(gainPct)}%).`
      : `Hold — ${signed(gainPct)}% (arms trail at +${tierParam(cfg.risk.trailArmPct, updated.tier)}%).`,
    kind: null,
    gainPct,
    position: updated,
  };
}

/**
 * Account-level daily circuit breaker. Compare start-of-day equity to now.
 * @returns {{tripped:boolean, drawdownPct:number, reason:string}}
 */
export function decideDailyStop(baselineEquity, currentEquity, cfg) {
  if (!(baselineEquity > 0)) return { tripped: false, drawdownPct: 0, reason: 'No baseline yet.' };
  const drawdownPct = round2(((baselineEquity - currentEquity) / baselineEquity) * 100);
  // A drawdown bigger than the suspect threshold is almost certainly a withdrawal,
  // not a loss — don't liquidate; flag for re-baseline.
  const suspect = cfg.daily.suspectMovePct != null && drawdownPct >= cfg.daily.suspectMovePct;
  const tripped = drawdownPct >= cfg.daily.stopPct && !suspect;
  return {
    tripped,
    drawdownPct,
    suspectTransfer: suspect,
    reason: suspect
      ? `Drawdown ${drawdownPct}% exceeds ${cfg.daily.suspectMovePct}% — likely a withdrawal, not a loss. Re-baseline; NOT tripping the stop.`
      : tripped
      ? `Daily stop TRIPPED: account down ${drawdownPct}% (limit ${cfg.daily.stopPct}%) — flatten + halt.`
      : `Daily drawdown ${drawdownPct}% (limit ${cfg.daily.stopPct}%).`,
  };
}

/**
 * Account-level daily PROFIT goal — the upside mirror of the daily stop. When the
 * account is up goalPct on the day, bank it: flatten + halt for the session.
 * @returns {{reached:boolean, gainPct:number, reason:string}}
 */
export function decideDailyGoal(baselineEquity, currentEquity, cfg) {
  if (!(baselineEquity > 0) || cfg.daily.goalPct == null) {
    return { reached: false, gainPct: 0, reason: 'No goal set / no baseline.' };
  }
  const gainPct = round2(((currentEquity - baselineEquity) / baselineEquity) * 100);
  // A gain bigger than the suspect threshold is almost certainly a deposit, not a
  // win — don't liquidate the book; flag for re-baseline.
  const suspect = cfg.daily.suspectMovePct != null && gainPct >= cfg.daily.suspectMovePct;
  const reached = gainPct >= cfg.daily.goalPct && !suspect;
  return {
    reached,
    gainPct,
    suspectTransfer: suspect,
    reason: suspect
      ? `Gain ${gainPct}% exceeds ${cfg.daily.suspectMovePct}% — likely a deposit, not a win. Re-baseline; NOT banking/halting.`
      : reached
      ? `Daily GOAL reached: account up ${gainPct}% (target ${cfg.daily.goalPct}%) — bank it + halt.`
      : `Daily gain ${gainPct}% (goal ${cfg.daily.goalPct}%).`,
  };
}

/**
 * Is a symbol we were stopped out of eligible for re-entry now?
 * @param {object} stopRec  state.stoppedOut[symbol] = {lastStopTime, countToday, day}
 * @param {number} nowMs
 * @returns {{eligible:boolean, reason:string}}
 */
export function reentryEligible(stopRec, nowMs, cfg) {
  if (!cfg.reentry.enabled) return { eligible: false, reason: 'Reentry disabled.' };
  if (!stopRec) return { eligible: true, reason: 'No prior stop-out — fresh entry.' };

  const sinceMin = (nowMs - stopRec.lastStopTime) / 60000;
  if (sinceMin < cfg.reentry.cooldownMin) {
    return { eligible: false, reason: `Cooldown: ${sinceMin.toFixed(0)}/${cfg.reentry.cooldownMin} min since stop-out.` };
  }
  if ((stopRec.countToday || 0) >= cfg.reentry.maxPerSymbolPerDay) {
    return { eligible: false, reason: `Reentry cap reached (${stopRec.countToday}/${cfg.reentry.maxPerSymbolPerDay} today).` };
  }
  return { eligible: true, reason: `Eligible — ${sinceMin.toFixed(0)} min since stop-out.` };
}

const signed = (v) => (v >= 0 ? `+${v}` : `${v}`);
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
