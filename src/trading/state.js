/**
 * Persistent cycle state. Held positions and buying power come from the broker
 * (source of truth) each cycle; this state layer only remembers what the broker
 * does NOT: engine-managed stop levels, running peaks, the day's equity baseline,
 * the daily-halt flag, and per-symbol stop-out history for the reentry cooldown.
 *
 * Settled cash is taken directly from the broker's buying_power (in a cash
 * account that IS the settled, tradeable figure) rather than modelled here, so
 * there's no settlement ledger to drift out of sync.
 *
 * Persisted as JSON (see scripts/trade_cycle.mjs / the auto-trade skill). The
 * clock is always injected (today, nowMs) so this module stays pure/testable.
 */
import { openPosition } from './riskEngine.js';
import { tierOf } from './config.js';

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    day: null,             // ET trading day this baseline belongs to (YYYY-MM-DD)
    baselineEquity: 0,     // account equity at the first cycle of the day
    halted: false,         // daily 3% stop tripped → no new entries today
    positions: {},         // symbol -> engine Position (stop/peak/trailArmed/…)
    stoppedOut: {},        // symbol -> {lastStopTime, countToday, day}
    lastCycle: null,       // ISO timestamp of the last cycle
  };
}

/** Fill in any missing fields on a loaded state blob. */
export function normalizeState(raw) {
  const s = { ...emptyState(), ...(raw || {}) };
  s.positions = raw?.positions || {};
  s.stoppedOut = raw?.stoppedOut || {};
  return s;
}

/**
 * Roll the day if needed: reset the equity baseline to the current equity, clear
 * the halt, and reset per-symbol reentry counters (lastStopTime is preserved so
 * the cooldown still applies across the open).
 */
export function rollDay(state, today, currentEquity) {
  if (state.day === today) return state;
  const stoppedOut = {};
  for (const [sym, rec] of Object.entries(state.stoppedOut || {})) {
    stoppedOut[sym] = { ...rec, countToday: 0, day: today };
  }
  return {
    ...state,
    day: today,
    baselineEquity: currentEquity,
    halted: false,
    stoppedOut,
    // Fresh day → reset the daily loss/goal + snipe counters.
    realizedToday: 0,
    snipeCount: 0,
    snipeLossToday: 0,
  };
}

/**
 * Merge broker positions with remembered engine state. Broker is authoritative
 * for symbol/shares/avg-cost; engine state supplies stop/peak/trailArmed. A
 * position seen at the broker but not in state is initialised from its avg cost.
 *
 * @param {Array} brokerPositions [{symbol, shares, avgPrice}]
 * @returns {Position[]}
 */
export function reconcilePositions(brokerPositions, state, cfg) {
  return (brokerPositions || [])
    .filter(bp => bp.shares > 0)
    .map(bp => {
      const known = state.positions[bp.symbol];
      if (known) {
        return { ...known, shares: bp.shares, entryPrice: known.entryPrice || bp.avgPrice };
      }
      const tier = state.positions[bp.symbol]?.tier || bp.tier || tierOf(bp.symbol, cfg) || 'core';
      return openPosition({
        symbol: bp.symbol,
        tier,
        shares: bp.shares,
        entryPrice: bp.avgPrice,
        entryTime: bp.entryTime || Date.parse(state.lastCycle || 0) || 0,
      }, cfg);
    });
}

/** Record a stop-out for the reentry cooldown/cap. Returns a new state. */
export function recordStopOut(state, symbol, nowMs, today) {
  const prev = state.stoppedOut[symbol];
  const countToday = prev && prev.day === today ? (prev.countToday || 0) + 1 : 1;
  return {
    ...state,
    stoppedOut: { ...state.stoppedOut, [symbol]: { lastStopTime: nowMs, countToday, day: today } },
  };
}
