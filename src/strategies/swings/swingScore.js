/**
 * Swing-candidate scorer — EXPERIMENTAL strategy, separate from the SPY core.
 *
 * The Robinhood scan already enforces the momentum/uptrend/liquidity gate
 * (RSI 55-72, ADX>22, MACD>0, price/cap floors). This scorer takes a survivor's
 * price + 52-week range + market cap and projects a plausible ~1-month (20-30
 * trading-day) target, tiers it, and sets a stop:
 *
 *   - aggressive tier  → target ~20-30%  (smaller/higher-beta names with the
 *                        volatility CAPACITY to move that much)
 *   - core tier        → target ~10-15%  (large-cap momentum)
 *
 * Targets are PROJECTIONS from the stock's own realized range, not promises —
 * the forward-trace scorecard grades the real hit-rate and we tune from that.
 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;

export function scoreSwing(c) {
  const { symbol, name = '', price, marketCap, high52, low52 } = c;
  const roomToHigh = r1(((high52 - price) / price) * 100);
  const annualRange = r1(((high52 - low52) / low52) * 100); // volatility-capacity proxy
  const capB = marketCap / 1e9;

  const aggressive = capB < 30 && annualRange >= 120;
  const tier = aggressive ? 'aggressive' : 'core';
  const targetPct = aggressive ? clamp(r1(annualRange / 6), 20, 30) : clamp(r1(annualRange / 8), 10, 15);
  const stopPct = aggressive ? 10 : 7;
  const targetPrice = r1(price * (1 + targetPct / 100));
  const stopPrice = r1(price * (1 - stopPct / 100));
  const rr = r1(targetPct / stopPct);

  const setup = roomToHigh < 3 ? 'breakout — at 52w high'
    : roomToHigh <= targetPct ? `room to 52w high (+${roomToHigh}%)`
      : `pullback below highs (${roomToHigh}% to prior high)`;

  // qualifies for announcement if the projected target clears the tier floor
  const qualifies = targetPct >= 10;
  return {
    symbol, name: name.slice(0, 24), price: r1(price), capB: r1(capB),
    tier, targetPct, targetPrice, stopPct, stopPrice, rr,
    roomToHigh, annualRange, setup, qualifies,
    why: `${tier} · ${annualRange}% annual range · ${setup}`,
  };
}

/** Rank a set of scored candidates (higher target × R:R, tie-break by capacity). */
export function rankSwings(scored) {
  return [...scored].filter((s) => s.qualifies)
    .sort((a, b) => (b.targetPct * b.rr) - (a.targetPct * a.rr) || b.annualRange - a.annualRange);
}
