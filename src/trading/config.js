/**
 * Auto-trading configuration — the single source of truth for every tunable in
 * the Robinhood auto-trader. The risk math, screener, sizing and planner are all
 * pure functions that take a config object; this file is the default the live
 * cycle loads. Edit numbers here (or override per-call) to retune the system.
 *
 * STRATEGY (built to compete on return %, not to be a diversified index):
 *   Concentrated momentum / relative-strength rotation over a curated, LIQUID
 *   universe — megacap leaders ("core") plus leveraged index/sector ETFs ("amp",
 *   the return amplifier). We ride strength with volatility-scaled trailing stops
 *   and only take longs when the broad market is risk-on.
 *
 * Why this shape on a $100 cash account:
 *   - Spreads are the P&L killer at this size → only liquid names, no penny junk.
 *   - Leverage comes from 3x ETFs (tight spreads, no expiry), NOT options
 *     (one contract eats the account; theta bleeds hourly).
 *   - Concentration (few positions) lets a winner actually move the needle.
 *   - A regime gate keeps us out of longs in a falling tape — the #1 small-acct
 *     killer — and the daily 3% breaker caps the worst day.
 *
 * House risk rules (as confirmed by the account owner), kept intact:
 *   - Daily account stop:  flatten + halt for the day if the account is down 3%.
 *   - Per-position stop:    initial hard stop below entry (tighter for core,
 *                           wider for the higher-vol amp tier).
 *   - Trail after a pop:    once up past the tier's arm threshold, switch to a
 *                           trailing stop that ratchets up to lock in profit.
 *   - Reentry when realized: after a stop-out, re-enter when the name re-ranks
 *                           as a buy (subject to a cooldown + settled cash).
 *
 * Account: the ONLY Robinhood account this agent may trade is the agentic-enabled
 * cash account below. Everything is sized/constrained for a small cash balance
 * (no margin, no shorting, cash-settlement / GFV aware).
 */

export const DEFAULT_CONFIG = {
  // ---- Account -------------------------------------------------------------
  account: {
    // agentic_allowed=true, cash, individual, nickname "Agentic".
    accountNumber: '521158774',
    type: 'cash',            // cash settlement → GFV-aware (see settlement below)
  },

  // ---- Daily account circuit breaker + profit goal ------------------------
  daily: {
    stopPct: 3,              // down 3% on the day → flatten all + halt new entries
    goalPct: 5,              // up 5% on the day → flatten all + bank the win, halt
    haltForRestOfDay: true,  // once tripped (either side), done for the session
    // Deposit/withdrawal guard: a same-day equity move larger than this is almost
    // certainly a cash transfer, not trading P&L — do NOT trip the stop/goal on it
    // (that would liquidate the book on a deposit). Re-baseline instead.
    suspectMovePct: 15,
  },

  // ---- Per-position risk (per tier — the amp tier is ~3x as volatile) ------
  risk: {
    // Initial hard stop distance below entry, by tier.
    initialStopPct:        { core: 3, amp: 7 },
    // Unrealized gain at which the trailing stop arms.
    trailArmPct:           { core: 3, amp: 5 },
    // Trailing stop distance below the running peak once armed (ratchets up only).
    trailPct:              { core: 3, amp: 6 },
    // Once peak gain ≥ this, the stop never drops below break-even.
    lockBreakevenAfterPct: { core: 5, amp: 9 },
  },

  // ---- Reentry after a stop-out -------------------------------------------
  reentry: {
    enabled: true,
    cooldownMin: 45,         // wait this long after a stop-out before re-buying
    maxPerSymbolPerDay: 2,   // cap churn: at most N re-entries per symbol per day
    requireSignalReconfirm: true, // must still rank as a momentum buy
  },

  // ---- Position sizing — CONCENTRATED (built for a ~$100 cash account) ------
  sizing: {
    maxPositions: 3,         // concentrate: few, higher-conviction positions
    cashBufferPct: 5,        // keep this % of equity in cash, never deploy it
    // Target split of deployed capital across tiers.
    tierSplit: { core: 0.5, amp: 0.5 },
    minOrderUsd: 5,          // don't place orders smaller than this
    maxPositionPct: 40,      // a single position may run up to this % of equity
  },

  // ---- Universe + screener (curated & liquid; ranked by momentum/RS) -------
  screen: {
    maxCandidates: 6,        // rank & keep this many before sizing picks from top
    // Authoritative universe. A candidate not in one of these lists is rejected —
    // this is how we stay liquid and avoid penny-stock spread tax.
    universe: {
      // Megacap momentum leaders — the steadier engine.
      core: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'AVGO', 'NFLX'],
      // Liquid leveraged index/sector ETFs — the return amplifier (~2–3x).
      amp:  ['TQQQ', 'SOXL', 'SPXL', 'TECL', 'FNGU', 'TNA', 'UPRO', 'LABU'],
    },
    minAvgDollarVol: 50e6,   // liquidity floor (all curated names clear this)
    minMomentumPct: 0.3,     // only buy names showing positive short-term momentum
    requireUptrend: true,    // trendScore must be ≥ 0 (don't buy falling knives)
    // Only open new longs when the broad market is risk-on (see regime.js).
    requireRiskOn: true,
    // Regime definition — tuned to capture intraday up-moves (a 10-day EMA is
    // responsive), not to demand a fully-confirmed multi-week uptrend. Risk-on
    // when the market proxy is green on the day AND holding above its short EMA.
    regime: {
      indexSymbol: 'SPY',    // broad-market proxy
      greenRequired: true,   // must be up on the day vs prior close
      trendEmaPeriod: 10,    // "short trend" = 10-day EMA (vs the old slow 20)
      emaTolerancePct: 0.2,  // count "on the line" (within 0.2% of the EMA) as above
      // Fold in the repo's SPY consensus call-out: a bearish call-out forces
      // risk-off even on a green day (confirming signal, only ever restricts).
      requireConsensusNotBearish: true,
      // "Active" posture: when the index is merely CHOPPY (green but below trend,
      // or vice-versa — not outright bearish), still trade the clearly strongest
      // names, just with a higher momentum bar. Off → stand fully aside in chop.
      activeInChop: true,
      chopMinMomentumPct: 2.5, // in chop, a name needs ≥ this day-change to buy
    },
    // Weights for the composite candidate score (momentum-forward for a race).
    scoreWeights: { momentum: 0.6, trend: 0.3, liquidity: 0.1 },
  },

  // ---- Execution -----------------------------------------------------------
  exec: {
    // Both tiers trade FRACTIONAL shares → MARKET orders, regular hours only.
    // Fractional is required at $100 (a whole share of a $78 leveraged ETF would
    // blow the per-position cap). Slippage on liquid names at ~$30 size is
    // negligible in RTH; RH also has no limit/stop on fractional shares.
    marketHours: 'regular_hours', // fractional/market only fill in RTH
    timeInForce: 'gfd',
    session: { openEt: '09:30', closeEt: '16:00' },
    // Stop losses are ENGINE-MANAGED (synthetic): RH has no resting stops on
    // fractional shares, so the cycle checks live price vs the stored stop each
    // run and sells when breached. Gap risk between cycles is accepted + logged.
    syntheticStops: true,
  },

  // ---- Options (ENABLED — single-leg long calls/puts, defined risk) --------
  // Active options arm: a call when the tape is bullish, a put when it's breaking
  // down. Long single-leg only → the premium is the entire max loss (no
  // assignment risk at level 2). Sized to a small slice of the account, ATM-ish
  // to limit theta, never 0-DTE. See src/trading/optionPlan.js.
  options: {
    enabled: true,
    minConviction: 'moderate', // take a call/put on a moderate+ directional read
    dte: [1, 7],              // near-dated but NOT 0-DTE (a bad hour isn't fatal)
    targetDelta: [0.45, 0.62], // ATM-ish: moves with the underlying, less theta
    minOpenInterest: 200,     // liquidity floor so we can get out
    allocationPct: 30,        // at most this % of equity in one contract's premium
    maxPremiumUsd: 45,        // hard $ cap on a single contract (= max loss)
    minPremiumUsd: 8,         // don't bother below this
    premiumTargetPct: 50,     // bank the contract at +50%
    premiumStopPct: 35,       // cut the contract at -35% (defined-risk stop)
    maxConcurrent: 1,         // at most one option position at a time (small acct)
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

/** Which tier a symbol belongs to (or null if it's outside the curated universe). */
export function tierOf(symbol, cfg) {
  const u = cfg.screen.universe;
  if (u.core.includes(symbol)) return 'core';
  if (u.amp.includes(symbol)) return 'amp';
  return null;
}
