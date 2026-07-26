/**
 * Universe screener — ranks an auto-screened mix of high-cap and low-priced
 * momentum names. Pure: the live agent gathers the market data (Robinhood /
 * Webull movers, fundamentals, quotes) and passes it in as plain candidate
 * records; this module applies the filters and scoring deterministically.
 *
 * Candidate input record:
 *   {
 *     symbol:       string,
 *     price:        number,   // last / current price
 *     marketCap:    number,   // USD market cap (from fundamentals)
 *     avgDollarVol: number,   // avg daily $ volume — liquidity proxy
 *     dayChangePct: number,   // intraday % change — momentum
 *     trendScore?:  number,   // optional [-1..+1] from technicals (default 0)
 *   }
 *
 * Output: { picks: RankedCandidate[], rejected: {symbol, reason}[] }
 * where each pick is tagged with tier ('highcap' | 'lowpriced') and a score.
 */

/** Classify a candidate into a tier, or null if it fits neither. */
function classify(c, cfg) {
  const H = cfg.screen.highcap;
  const L = cfg.screen.lowpriced;
  if (c.marketCap >= H.minMarketCap) return 'highcap';
  if (c.price >= L.minPrice && c.price <= L.maxPrice && c.marketCap >= L.minMarketCap) return 'lowpriced';
  return null;
}

/** Passes the tier's price/liquidity floors? Returns null if ok, else a reason. */
function rejectReason(c, tier, cfg) {
  const f = cfg.screen[tier];
  if (c.avgDollarVol < f.minAvgDollarVol) {
    return `illiquid ($${fmtNum(c.avgDollarVol)}/day < $${fmtNum(f.minAvgDollarVol)})`;
  }
  if (tier === 'lowpriced' && (c.price < f.minPrice || c.price > f.maxPrice)) {
    return `price ${c.price} outside low-priced band ${f.minPrice}-${f.maxPrice}`;
  }
  if (c.dayChangePct < cfg.screen.minMomentumPct) {
    return `momentum ${c.dayChangePct}% < ${cfg.screen.minMomentumPct}%`;
  }
  return null;
}

/** Composite score in [0..1], higher is a stronger buy candidate. */
function scoreOf(c, cfg) {
  const w = cfg.screen.scoreWeights;
  // Momentum: 0% → 0, +5% → ~1 (clamped).
  const momentum = clamp01(c.dayChangePct / 5);
  // Trend: map [-1..+1] → [0..1].
  const trend = clamp01(((c.trendScore ?? 0) + 1) / 2);
  // Liquidity: log-scaled up to $500M/day.
  const liquidity = clamp01(Math.log10(Math.max(1, c.avgDollarVol)) / Math.log10(5e8));
  return round3(momentum * w.momentum + trend * w.trend + liquidity * w.liquidity);
}

export function screen(candidates, cfg) {
  const picks = [];
  const rejected = [];

  for (const c of candidates || []) {
    if (!(c.price > 0) || !(c.marketCap > 0)) {
      rejected.push({ symbol: c.symbol, reason: 'missing price/marketCap' });
      continue;
    }
    const tier = classify(c, cfg);
    if (!tier) {
      rejected.push({ symbol: c.symbol, reason: 'fits neither high-cap nor low-priced band' });
      continue;
    }
    const reason = rejectReason(c, tier, cfg);
    if (reason) {
      rejected.push({ symbol: c.symbol, reason });
      continue;
    }
    picks.push({ ...c, tier, score: scoreOf(c, cfg) });
  }

  picks.sort((a, b) => b.score - a.score);
  return { picks: picks.slice(0, cfg.screen.maxCandidates), rejected };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmtNum(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}
