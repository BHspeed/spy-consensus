/**
 * Auto-trading configuration — the single source of truth for every tunable in
 * the Robinhood auto-trader. The risk math, screener, sizing and planner are all
 * pure functions that take a config object; this file is the default the live
 * cycle loads. Edit numbers here (or override per-call) to retune the system.
 *
 * House rules encoded (as confirmed by the account owner):
 *   - Daily account stop:   flatten + halt for the day if the account is down 3%.
 *   - Per-position stop:     initial hard stop 3–5% below entry (tighter for
 *                            high-cap, wider for low-priced).
 *   - Trail after +3%:       once a position is up >3%, switch to a trailing stop
 *                            that ratchets up to lock in profit.
 *   - Reentry when realized:  after a stop-out, re-enter when the entry signal
 *                            re-fires (subject to a cooldown + settled cash).
 *   - Universe:              auto-screened mix of high-cap (fractional) and
 *                            low-priced (whole-share) momentum names.
 *
 * Account: the ONLY Robinhood account this agent may trade is the agentic-enabled
 * cash account below. Everything is sized and constrained for a small cash
 * balance (no margin, no shorting, cash-settlement / GFV aware).
 */

export const DEFAULT_CONFIG = {
  // ---- Account -------------------------------------------------------------
  account: {
    // agentic_allowed=true, cash, individual, nickname "Agentic".
    accountNumber: '521158774',
    type: 'cash',            // cash settlement → GFV-aware (see settlement below)
  },

  // ---- Daily account circuit breaker --------------------------------------
  daily: {
    stopPct: 3,              // down 3% on the day → flatten all + halt new entries
    haltForRestOfDay: true,  // once tripped, no re-entries until next session
  },

  // ---- Per-position risk ---------------------------------------------------
  risk: {
    // Initial hard stop distance below entry, by tier. "3–5% of position".
    initialStopPct: { highcap: 3, lowpriced: 5 },
    // Once unrealized gain reaches this, arm the trailing stop.
    trailArmPct: 3,
    // Trailing stop distance below the peak once armed. Ratchets up only.
    trailPct: 3,
    // Never let the trailing stop sit below break-even once we've armed + moved
    // enough; locks in at least this much once arm+lock threshold is passed.
    lockBreakevenAfterPct: 5, // when peak gain ≥5%, stop never drops below entry
  },

  // ---- Reentry after a stop-out -------------------------------------------
  reentry: {
    enabled: true,
    cooldownMin: 30,         // wait this long after a stop-out before re-buying
    maxPerSymbolPerDay: 2,   // cap churn: at most N re-entries per symbol per day
    requireSignalReconfirm: true, // screener must still rank the name a buy
  },

  // ---- Position sizing (built for a ~$100 cash account) --------------------
  sizing: {
    maxPositions: 5,         // max concurrent open positions
    cashBufferPct: 5,        // keep this % of equity in cash, never deploy it
    // Target split of deployed capital across tiers.
    tierSplit: { highcap: 0.6, lowpriced: 0.4 },
    minOrderUsd: 5,          // don't place orders smaller than this
    maxPositionPct: 30,      // no single position may exceed this % of equity
  },

  // ---- Universe screener ---------------------------------------------------
  screen: {
    maxCandidates: 8,        // rank & keep this many before sizing picks from top
    highcap: {
      minMarketCap: 20e9,    // "high cap" floor
      minAvgDollarVol: 50e6, // liquidity floor
    },
    lowpriced: {
      minPrice: 1.5,         // avoid true penny stocks
      maxPrice: 15,          // "low priced"
      minMarketCap: 100e6,   // avoid nano-cap junk
      minAvgDollarVol: 10e6, // must be liquid enough to enter/exit cleanly
    },
    // Momentum gate: only buy names showing positive short-term momentum.
    minMomentumPct: 0,       // day-change % floor for a candidate to be buyable
    // Weights for the composite candidate score.
    scoreWeights: { momentum: 0.5, trend: 0.3, liquidity: 0.2 },
  },

  // ---- Execution -----------------------------------------------------------
  exec: {
    // High-cap positions are fractional → must be MARKET + regular hours on RH.
    // Low-priced positions are whole shares → marketable LIMIT for price safety.
    marketableLimitSlipPct: 0.5, // pad the ask/bid by this % on marketable limits
    marketHours: 'regular_hours', // stops/market only fill in RTH
    timeInForce: 'gfd',
    // Only trade inside the regular session window (ET). The cycle skips
    // otherwise. Kept here for the runbook / offline checks.
    session: { openEt: '09:30', closeEt: '16:00' },
    // Stop losses are ENGINE-MANAGED (synthetic): RH has no resting stops on
    // fractional shares, so the cycle checks live price vs the stored stop each
    // run and sells when breached. Gap risk between cycles is accepted + logged.
    syntheticStops: true,
  },

  // ---- Cash settlement / GFV protection (cash account) --------------------
  settlement: {
    // In a cash account, sale proceeds settle T+1. Reusing unsettled proceeds to
    // buy then selling again before settlement is a Good Faith Violation. We only
    // deploy settled cash for new entries to stay clear of GFVs.
    onlyDeploySettledCash: true,
    settlementDays: 1,       // T+1
  },
};

/** Deep-ish merge of a partial override onto DEFAULT_CONFIG (one level of nesting). */
export function loadConfig(overrides = {}) {
  const out = structuredClone(DEFAULT_CONFIG);
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v))
      ? { ...out[k], ...v }
      : v;
  }
  return out;
}
