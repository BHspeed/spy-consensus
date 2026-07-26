/**
 * Cycle planner — the deterministic brain of one auto-trading cycle. Given the
 * clock, the broker snapshot, remembered engine state, live quotes and screened
 * candidates, it returns an ordered list of concrete order actions plus the next
 * state to persist. It never calls the network or the clock; the live agent
 * feeds it data and then executes the returned actions via the Robinhood MCP.
 *
 * Action ordering is deliberate: EXITS (risk reduction) are always emitted and
 * executed before ENTRIES, and the daily circuit breaker short-circuits entries
 * entirely.
 *
 * @param {Object} input
 * @param {number} input.now            epoch ms
 * @param {string} input.today          ET trading day 'YYYY-MM-DD'
 * @param {boolean} input.marketOpen    is it the regular session right now?
 * @param {Object} input.account        {equity, buyingPower}  (buyingPower = settled cash)
 * @param {Object} input.state          persisted engine state (see state.js)
 * @param {Array}  input.brokerPositions[{symbol, shares, avgPrice, tier?}]
 * @param {Object} input.quotes         {SYMBOL: price} for held + candidate symbols
 * @param {Array}  input.candidates     raw screener candidate records
 * @param {Object} cfg
 * @returns {{actions:Array, nextState:Object, dailyStop:Object, halted:boolean, notes:string[]}}
 */
import { decidePositionExit, decideDailyStop, reentryEligible, openPosition } from './riskEngine.js';
import { rollDay, reconcilePositions, recordStopOut } from './state.js';
import { screen } from './screener.js';
import { planEntries } from './sizing.js';

export function planCycle(input, cfg) {
  const { now, today, marketOpen, account, quotes = {}, candidates = [] } = input;
  const notes = [];
  const actions = [];

  // ---- Day roll + baseline -------------------------------------------------
  let state = rollDay(input.state, today, account.equity);

  // ---- Daily circuit breaker ----------------------------------------------
  const dailyStop = decideDailyStop(state.baselineEquity, account.equity, cfg);
  let positions = reconcilePositions(input.brokerPositions, state, cfg);

  if (!marketOpen) {
    notes.push('Market closed — monitoring only, no orders.');
    // Still persist any freshly reconciled positions so stops are tracked.
    state = { ...state, positions: indexBy(positions), lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, halted: state.halted, notes };
  }

  if (dailyStop.tripped) {
    state = { ...state, halted: true };
    if (cfg.daily.haltForRestOfDay) notes.push(dailyStop.reason);
    // Flatten everything, fast.
    for (const pos of positions) {
      const px = quotes[pos.symbol];
      actions.push(sellAction(pos, px, cfg, `DAILY STOP: ${dailyStop.reason}`));
      state = recordStopOut(state, pos.symbol, now, today);
    }
    state = { ...state, positions: {}, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, halted: true, notes };
  }

  // ---- Manage open positions (exits + trailing ratchet) -------------------
  const nextPositions = {};
  for (const pos of positions) {
    const px = quotes[pos.symbol];
    if (!(px > 0)) { notes.push(`${pos.symbol}: no quote — holding, stop unchanged.`); nextPositions[pos.symbol] = pos; continue; }
    const d = decidePositionExit(pos, px, cfg);
    if (d.action === 'SELL') {
      actions.push(sellAction(d.position, px, cfg, d.reason));
      state = recordStopOut(state, pos.symbol, now, today);
    } else {
      nextPositions[pos.symbol] = d.position; // keep the ratcheted stop/peak
    }
  }
  state = { ...state, positions: nextPositions };

  // ---- Entries (skipped entirely if halted earlier today) -----------------
  if (state.halted && cfg.daily.haltForRestOfDay) {
    notes.push('Halted for the day — no new entries.');
    state = { ...state, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, halted: true, notes };
  }

  // Regime gate: don't open new longs into a falling tape.
  if (cfg.screen.requireRiskOn && !(input.regime && input.regime.riskOn)) {
    notes.push(`Risk-OFF regime${input.regime?.reason ? ` (${input.regime.reason})` : ''} — no new entries, holding/trailing only.`);
    state = { ...state, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, halted: state.halted, notes };
  }

  const { picks, rejected } = screen(candidates, cfg);
  if (rejected.length) notes.push(`Screened out ${rejected.length} candidate(s).`);

  // Drop names on reentry cooldown / cap.
  const heldSyms = new Set(Object.keys(nextPositions));
  const buyable = picks.filter(p => {
    if (heldSyms.has(p.symbol)) return false;
    const gate = reentryEligible(state.stoppedOut[p.symbol], now, cfg);
    if (!gate.eligible) { notes.push(`${p.symbol}: ${gate.reason}`); return false; }
    return true;
  });

  const openList = Object.values(nextPositions).map(p => ({ symbol: p.symbol, tier: p.tier }));
  const { entries, notes: sizeNotes } = planEntries({
    equity: account.equity,
    settledCash: account.buyingPower,
    openPositions: openList,
    picks: buyable,
  }, cfg);
  notes.push(...sizeNotes);

  const priceOf = Object.fromEntries(buyable.map(p => [p.symbol, p.price]));
  for (const e of entries) {
    const px = priceOf[e.symbol];
    actions.push(buyAction(e, px, cfg));
    // Optimistically record the intended position so subsequent cycles manage it;
    // the next cycle reconciles against actual broker fills.
    state.positions[e.symbol] = openPosition({
      symbol: e.symbol, tier: e.tier, shares: e.shares, entryPrice: px, entryTime: now,
    }, cfg);
  }

  state = { ...state, lastCycle: iso(now) };
  return { actions, nextState: state, dailyStop, halted: state.halted, notes };
}

// ---- Action builders -------------------------------------------------------

function sellAction(pos, price, cfg, reason) {
  // Positions are fractional → exits are MARKET (RH has no fractional limit/stop).
  return { type: 'SELL', symbol: pos.symbol, shares: pos.shares, tier: pos.tier, reason, orderType: 'market' };
}

function buyAction(entry, price, cfg) {
  // Fractional entries are MARKET orders (RTH only).
  return { type: 'BUY', symbol: entry.symbol, tier: entry.tier, shares: entry.shares, usd: entry.usd, orderType: 'market' };
}

// ---- helpers ---------------------------------------------------------------
function indexBy(positions) { return Object.fromEntries(positions.map(p => [p.symbol, p])); }
function iso(ms) { return new Date(ms).toISOString(); }
function round2(v) { return Math.round(v * 100) / 100; }
