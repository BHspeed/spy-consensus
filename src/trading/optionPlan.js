/**
 * Single-leg option selection + management — the options arm of the auto-trader.
 * Pure and deterministic: the live agent pulls an option chain via the Robinhood
 * MCP and passes a normalized snapshot here; this module picks an AFFORDABLE
 * contract that fits the account, sizes it, and defines a premium-based
 * stop/target. It never touches the network.
 *
 * Philosophy for a tiny account:
 *   - Long single-leg only (calls when bullish, puts when bearish) — defined risk
 *     (you can only lose the premium), no assignment surprises.
 *   - Prefer ATM-ish (delta ~0.45–0.60): far-OTM lottery tickets bleed theta and
 *     usually expire worthless. Slightly-in/at-the-money moves with the underlying.
 *   - No 0-DTE: require ≥ minDte so a bad hour isn't instantly fatal.
 *   - Cap premium at a small slice of the account; the premium IS the max loss.
 *
 * Contract snapshot record (agent builds from get_option_instruments/quotes):
 *   { id, type:'call'|'put', strike, expiration, dte, delta, bid, ask, mark,
 *     openInterest, volume }
 *
 * @param {Object} args
 * @param {'long'|'short'} args.direction  long → call, short → put
 * @param {string} args.underlying
 * @param {Array}  args.chain              contract snapshots
 * @param {number} args.buyingPower        settled cash available
 * @param {number} args.equity             account value (for allocation cap)
 * @param {Object} cfg
 * @returns {{consider:boolean, reason:string, contract?, cost?, premiumStopPct?, premiumTargetPct?}}
 */
export function selectOption({ direction, underlying, chain, buyingPower, equity }, cfg) {
  const o = cfg.options;
  if (!o.enabled) return { consider: false, reason: 'options disabled' };

  const want = direction === 'short' ? 'put' : 'call';
  // Budget = min(configured $ cap, an allocation of equity, settled cash).
  // allocationPct/minPremiumUsd are OPTIONAL: the snipe arm (cfg.snipe) sizes purely
  // by maxPremiumUsd + buying power and defines neither. Treat a missing allocationPct
  // as "no equity-fraction cap" (100%) and a missing minPremiumUsd as 0 — otherwise
  // `equity * (undefined/100)` is NaN and every candidate is silently rejected.
  const allocPct = Number.isFinite(o.allocationPct) ? o.allocationPct : 100;
  const minPremium = Number.isFinite(o.minPremiumUsd) ? o.minPremiumUsd : 0;
  const budget = Math.min(o.maxPremiumUsd, equity * (allocPct / 100), buyingPower);
  if (budget < minPremium) {
    return { consider: false, reason: `budget $${round2(budget)} < min premium $${minPremium}` };
  }

  const [dLo, dHi] = o.targetDelta;
  const [tLo, tHi] = o.dte;
  const candidates = (chain || []).filter(c => {
    if (c.type !== want) return false;
    if (!(c.dte >= tLo && c.dte <= tHi)) return false;
    const absDelta = Math.abs(c.delta ?? 0);
    if (!(absDelta >= dLo && absDelta <= dHi)) return false;
    if ((c.openInterest ?? 0) < o.minOpenInterest && (c.volume ?? 0) < o.minOpenInterest) return false;
    const costPer = (c.ask ?? c.mark ?? 0) * 100;
    return costPer > 0 && costPer <= budget;
  });

  if (candidates.length === 0) {
    return { consider: false, reason: `no affordable ${want} within budget $${round2(budget)} / delta ${dLo}-${dHi} / dte ${tLo}-${tHi}` };
  }

  // Rank: closest to the middle of the delta band (most "with the underlying"),
  // then most liquid, then cheapest.
  const midDelta = (dLo + dHi) / 2;
  candidates.sort((a, b) => {
    const da = Math.abs(Math.abs(a.delta) - midDelta) - Math.abs(Math.abs(b.delta) - midDelta);
    if (Math.abs(da) > 0.02) return da;
    const liq = (b.openInterest ?? 0) - (a.openInterest ?? 0);
    if (liq !== 0) return liq;
    return (a.ask ?? a.mark) - (b.ask ?? b.mark);
  });

  const pick = candidates[0];
  const cost = round2((pick.ask ?? pick.mark) * 100);
  return {
    consider: true,
    reason: `${underlying} ${want} ${pick.strike} exp ${pick.expiration} (~${Math.round(Math.abs(pick.delta) * 100)}Δ, ${pick.dte}DTE) — $${cost}`,
    contract: pick,
    cost,
    premiumStopPct: o.premiumStopPct,     // exit if the contract loses this % of premium
    premiumTargetPct: o.premiumTargetPct, // bank if it gains this %
  };
}

/**
 * Manage an open option by its premium since entry. Mirror of the equity stop but
 * on the contract's mark: hard target, hard stop, and a give-back trail once
 * it's profitable.
 * @returns {{action:'HOLD'|'SELL', reason:string, gainPct:number}}
 */
export function decideOptionExit(entryPremium, currentPremium, cfg) {
  const o = cfg.options;
  if (!(entryPremium > 0)) throw new Error('entryPremium must be > 0');
  const gainPct = round2(((currentPremium - entryPremium) / entryPremium) * 100);
  if (gainPct >= o.premiumTargetPct) return { action: 'SELL', reason: `Option +${gainPct}% — bank (target ${o.premiumTargetPct}%).`, gainPct };
  if (gainPct <= -o.premiumStopPct) return { action: 'SELL', reason: `Option ${gainPct}% — stop (-${o.premiumStopPct}%).`, gainPct };
  return { action: 'HOLD', reason: `Option ${gainPct >= 0 ? '+' : ''}${gainPct}% (target ${o.premiumTargetPct}% / stop -${o.premiumStopPct}%).`, gainPct };
}

function round2(v) { return Math.round(v * 100) / 100; }
