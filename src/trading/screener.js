/**
 * Universe screener — ranks a curated, liquid momentum universe (megacap "core"
 * leaders + leveraged-ETF "amp" names) by relative strength. Pure: the live agent
 * gathers the market data (quotes, day-change, a trend read) and passes it in as
 * plain candidate records; this module tags the tier, applies the gates, and
 * scores/ranks deterministically.
 *
 * Staying inside the curated universe is deliberate — it's how we avoid the
 * penny-stock spread tax and single-name blowups that quietly kill a $100 acct.
 *
 * Candidate input record:
 *   {
 *     symbol:       string,
 *     price:        number,   // last / current price
 *     avgDollarVol: number,   // avg daily $ volume — liquidity proxy
 *     dayChangePct: number,   // intraday % change — momentum
 *     trendScore?:  number,   // [-1..+1] short-term trend (e.g. price vs EMA)
 *   }
 *
 * Output: { picks: RankedCandidate[], rejected: {symbol, reason}[] }
 * each pick tagged with tier ('core' | 'amp') and a composite score.
 */
import { tierOf } from './config.js';

/** Passes the gates? Returns null if ok, else a rejection reason. */
function rejectReason(c, cfg) {
  if (c.avgDollarVol < cfg.screen.minAvgDollarVol) {
    return `illiquid ($${fmtNum(c.avgDollarVol)}/day < $${fmtNum(cfg.screen.minAvgDollarVol)})`;
  }
  if (c.dayChangePct < cfg.screen.minMomentumPct) {
    return `momentum ${c.dayChangePct}% < ${cfg.screen.minMomentumPct}%`;
  }
  if (cfg.screen.requireUptrend && (c.trendScore ?? 0) < 0) {
    return `downtrend (trendScore ${c.trendScore})`;
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
  // Liquidity: log-scaled up to $1B/day.
  const liquidity = clamp01(Math.log10(Math.max(1, c.avgDollarVol)) / Math.log10(1e9));
  return round3(momentum * w.momentum + trend * w.trend + liquidity * w.liquidity);
}

export function screen(candidates, cfg) {
  const picks = [];
  const rejected = [];

  for (const c of candidates || []) {
    if (!(c.price > 0)) { rejected.push({ symbol: c.symbol, reason: 'missing price' }); continue; }
    const tier = tierOf(c.symbol, cfg);
    if (!tier) { rejected.push({ symbol: c.symbol, reason: 'outside curated universe' }); continue; }
    const reason = rejectReason(c, cfg);
    if (reason) { rejected.push({ symbol: c.symbol, reason }); continue; }
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
