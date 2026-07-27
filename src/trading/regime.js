/**
 * Market-regime assessment — the "should we be taking new longs at all right now?"
 * gate. Pure and deterministic so the live agent doesn't judge it by feel: it
 * fetches the broad-market proxy (SPY) and hands the numbers here.
 *
 * Risk-ON when the proxy is green on the day AND trading at/above its short-term
 * (10-day) EMA. The short EMA is deliberate: it's responsive enough to turn
 * risk-on on a strong up-day (so we participate in daily momentum) while still
 * standing us aside on red / clearly-broken-down days.
 *
 * @param {Object} m
 * @param {number} m.price       current proxy price
 * @param {number} m.priorClose  prior session close
 * @param {number} [m.ema]       proxy's short EMA (period = cfg.screen.regime.trendEmaPeriod);
 *                               omit to skip the trend check (green-only)
 * @param {Object} cfg
 * @returns {{riskOn:boolean, reason:string, dayChangePct:number}}
 */
export function assessRegime({ price, priorClose, ema }, cfg) {
  const r = cfg.screen.regime;
  const tol = r.emaTolerancePct / 100;
  const dayChangePct = priorClose > 0 ? round2(((price - priorClose) / priorClose) * 100) : 0;
  const green = price > priorClose;
  const aboveTrend = ema == null ? true : price >= ema * (1 - tol);
  const belowTrend = ema == null ? false : price <= ema * (1 + tol);

  // posture: clean up-tape, clean down-tape, or chop (mixed).
  const posture =
    (!r.greenRequired || green) && aboveTrend ? 'long' :
    !green && belowTrend ? 'bearish' : 'chop';
  const riskOn = posture === 'long';

  const trendStr = ema == null
    ? 'no-trend-check'
    : `${aboveTrend ? 'above' : 'below'} ${r.trendEmaPeriod}d-EMA (${round2(price)} vs ${round2(ema)})`;
  const reason = `${r.indexSymbol} ${green ? 'green' : 'red'} ${dayChangePct >= 0 ? '+' : ''}${dayChangePct}%, ${trendStr}`;
  return { riskOn, posture, reason, dayChangePct };
}

/**
 * Entry posture for the planner: given the (possibly call-out-adjusted) regime,
 * may we open new longs this cycle, and with what momentum floor?
 * - long    → yes, normal momentum floor.
 * - chop    → yes only if activeInChop, with the higher chopMinMomentumPct floor.
 * - bearish → no new longs.
 * @returns {{allowLongs:boolean, momentumFloor:number, label:string}}
 */
export function entryPosture(regime, cfg) {
  const r = cfg.screen.regime;
  const posture = regime?.posture ?? (regime?.riskOn ? 'long' : 'bearish');
  if (posture === 'long') return { allowLongs: true, momentumFloor: cfg.screen.minMomentumPct, label: 'risk-on' };
  if (posture === 'chop' && r.activeInChop) return { allowLongs: true, momentumFloor: r.chopMinMomentumPct, label: 'chop (strong names only)' };
  return { allowLongs: false, momentumFloor: cfg.screen.minMomentumPct, label: posture === 'chop' ? 'chop (stand aside)' : 'bearish' };
}

/**
 * Fold the SPY consensus call-out into the price/EMA regime. The call-out can
 * only ever RESTRICT (make us safer): an outright bearish call-out forces
 * risk-off even on a green day. A bullish/neutral call-out passes the base
 * regime through, annotated with the call-out and its conviction.
 * @param {{riskOn:boolean, reason:string, dayChangePct:number}} base
 * @param {object|null} spySig  from spyConsensus.normalizeSignal()
 * @param {object} cfg
 */
export function combineRegime(base, spySig, cfg) {
  if (!spySig) return base;
  const block = cfg.screen.regime.requireConsensusNotBearish && spySig.bearish;
  return {
    riskOn: base.riskOn && !block,
    posture: block ? 'bearish' : base.posture, // a bearish call-out downgrades posture
    dayChangePct: base.dayChangePct,
    conviction: spySig.conviction,
    reason: block
      ? `${base.reason}; BLOCKED by ${spySig.reason}`
      : `${base.reason}; ${spySig.reason}`,
  };
}

/**
 * Bidirectional direction read for the options arm: are we leaning LONG (buy a
 * call / shares), SHORT (buy a put), or FLAT (chop — don't force a trade)?
 * Long and short each require agreement between the day's direction, the short
 * trend, and (if present) the SPY call-out. Genuine chop → flat, on purpose:
 * "active" does not mean trading every ambiguous tape.
 *
 * @param {{price:number, priorClose:number, ema:number}} m
 * @param {object|null} spySig  from spyConsensus.normalizeSignal()
 * @returns {{direction:'long'|'short'|'flat', reason:string}}
 */
export function assessDirection(m, spySig, cfg) {
  const tol = cfg.screen.regime.emaTolerancePct / 100;
  const green = m.price > m.priorClose;
  const aboveTrend = m.price >= m.ema * (1 - tol);
  const belowTrend = m.price <= m.ema * (1 + tol);

  const callBearish = spySig?.bearish;
  const callBullish = spySig?.bullish;

  if (green && aboveTrend && !callBearish) {
    return { direction: 'long', reason: `long — SPY green & ≥ ${cfg.screen.regime.trendEmaPeriod}d-EMA${spySig ? `, call-out ${spySig.bias}` : ''}` };
  }
  if (!green && belowTrend && !callBullish) {
    return { direction: 'short', reason: `short — SPY red & ≤ ${cfg.screen.regime.trendEmaPeriod}d-EMA${spySig ? `, call-out ${spySig.bias}` : ''}` };
  }
  return { direction: 'flat', reason: `flat — mixed tape (green=${green}, aboveEMA=${aboveTrend}${spySig ? `, call-out ${spySig.bias}` : ''})` };
}

function round2(v) { return Math.round(v * 100) / 100; }
