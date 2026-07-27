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
import { decidePositionExit, decideDailyStop, decideDailyGoal, reentryEligible, openPosition } from './riskEngine.js';
import { rollDay, reconcilePositions, recordStopOut } from './state.js';
import { screen } from './screener.js';
import { planEntries } from './sizing.js';
import { entryPosture } from './regime.js';

export function planCycle(input, cfg) {
  const { now, today, marketOpen, account, quotes = {}, candidates = [] } = input;
  const notes = [];
  const actions = [];

  // ---- Day roll + baseline -------------------------------------------------
  let state = rollDay(input.state, today, account.equity);

  // ---- Daily circuit breaker + profit goal --------------------------------
  const dailyStop = decideDailyStop(state.baselineEquity, account.equity, cfg);
  const dailyGoal = decideDailyGoal(state.baselineEquity, account.equity, cfg);
  let positions = reconcilePositions(input.brokerPositions, state, cfg);

  if (!marketOpen) {
    notes.push('Market closed — monitoring only, no orders.');
    // Still persist any freshly reconciled positions so stops are tracked.
    state = { ...state, positions: indexBy(positions), lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, dailyGoal, halted: state.halted, notes };
  }

  // Either the daily loss stop OR the daily profit goal flattens + halts.
  if (dailyStop.tripped || dailyGoal.reached) {
    const trigger = dailyStop.tripped ? `DAILY STOP: ${dailyStop.reason}` : `DAILY GOAL: ${dailyGoal.reason}`;
    state = { ...state, halted: true };
    if (cfg.daily.haltForRestOfDay) notes.push(dailyStop.tripped ? dailyStop.reason : dailyGoal.reason);
    // Flatten everything, fast.
    for (const pos of positions) {
      const px = quotes[pos.symbol];
      actions.push(sellAction(pos, px, cfg, trigger));
      state = recordStopOut(state, pos.symbol, now, today);
    }
    state = { ...state, positions: {}, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, dailyGoal, halted: true, notes };
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

  // ---- Manage-only pass: stop here (the 15-min risk heartbeat) -------------
  // Exits + trailing ratchet + the daily breaker have all run above; we just
  // skip screening/entries. Used by the intra-hour passes so a rapid re-fire can
  // only ever tighten risk, never open a duplicate position.
  if (input.manageOnly) {
    notes.push('Manage-only pass — exits/trailing checked, no new entries.');
    state = { ...state, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, dailyGoal, halted: state.halted, notes };
  }

  // ---- Entries (skipped entirely if halted earlier today) -----------------
  if (state.halted && cfg.daily.haltForRestOfDay) {
    notes.push('Halted for the day — no new entries.');
    state = { ...state, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, dailyGoal, halted: true, notes };
  }

  // Regime gate (posture-aware): full participation when risk-on, strong-names-
  // only in chop, stand aside when bearish.
  const posture = cfg.screen.requireRiskOn
    ? entryPosture(input.regime, cfg)
    : { allowLongs: true, momentumFloor: cfg.screen.minMomentumPct, label: 'gate off' };
  if (!posture.allowLongs) {
    notes.push(`No new entries — ${posture.label}${input.regime?.reason ? ` (${input.regime.reason})` : ''}; holding/trailing only.`);
    state = { ...state, lastCycle: iso(now) };
    return { actions, nextState: state, dailyStop, dailyGoal, halted: state.halted, notes };
  }
  if (posture.label.startsWith('chop')) notes.push(`Chop posture — strong names only (momentum ≥ ${posture.momentumFloor}%).`);

  const { picks, rejected } = screen(candidates, cfg);
  if (rejected.length) notes.push(`Screened out ${rejected.length} candidate(s).`);

  // Drop names on reentry cooldown / cap, and (in chop) below the raised floor.
  const heldSyms = new Set(Object.keys(nextPositions));
  const buyable = picks.filter(p => {
    if (heldSyms.has(p.symbol)) return false;
    if (p.dayChangePct < posture.momentumFloor) { notes.push(`${p.symbol}: momentum ${p.dayChangePct}% < posture floor ${posture.momentumFloor}%`); return false; }
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
  return { actions, nextState: state, dailyStop, dailyGoal, halted: state.halted, notes };
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
