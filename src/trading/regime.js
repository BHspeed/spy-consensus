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
  const dayChangePct = priorClose > 0 ? round2(((price - priorClose) / priorClose) * 100) : 0;
  const green = price > priorClose;
  const aboveTrend = ema == null ? true : price >= ema * (1 - r.emaTolerancePct / 100);

  const riskOn = (!r.greenRequired || green) && aboveTrend;
  const trendStr = ema == null
    ? 'no-trend-check'
    : `${aboveTrend ? 'above' : 'below'} ${r.trendEmaPeriod}d-EMA (${round2(price)} vs ${round2(ema)})`;
  const reason = `${r.indexSymbol} ${green ? 'green' : 'red'} ${dayChangePct >= 0 ? '+' : ''}${dayChangePct}%, ${trendStr}`;
  return { riskOn, reason, dayChangePct };
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
    dayChangePct: base.dayChangePct,
    conviction: spySig.conviction,
    reason: block
      ? `${base.reason}; BLOCKED by ${spySig.reason}`
      : `${base.reason}; ${spySig.reason}`,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
