/**
 * Option-selection layer.
 *
 * Turns a direction-consensus verdict + a live option chain into a ranked list
 * of concrete trade choices, each with a confidence score and a plain rationale.
 *
 * Tuned for the trader's style: short-hold (≤3 days), profit taken on VALUE
 * FLIPS rather than at expiry. Because the exit is early, the expiry-based
 * probability (Robinhood's chance_of_profit_long) is de-emphasised; what matters
 * more is directional edge (consensus), responsiveness (delta), and the ability
 * to get in and out cleanly (liquidity / tight spread).
 *
 * Contract shape (normalise from Robinhood with fromRobinhood()):
 *   { type:'call'|'put', strike, mark, bid, ask, delta, iv, oi, volume, breakeven, popLong }
 */

/** Normalise a Robinhood instrument+quote pair into a contract. */
export function fromRobinhood(strike, type, q) {
  return {
    type, strike: +strike,
    mark: +q.mark_price, bid: +q.bid_price, ask: +q.ask_price,
    delta: +q.delta, iv: +q.implied_volatility,
    oi: +q.open_interest, volume: +q.volume,
    breakeven: +q.break_even_price, popLong: +q.chance_of_profit_long,
  };
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => { const m = 10 ** d; return Math.round(v * m) / m; };

/** Liquidity 0..100 from bid/ask tightness, knocked down if OI/volume are thin. */
function liqScore(c) {
  if (!(c.mark > 0) || !(c.ask > 0)) return 0;
  const spreadPct = (c.ask - c.bid) / c.mark;
  let s = clamp(100 - spreadPct * 800);
  if (c.oi < 500 && c.volume < 1000) s *= 0.55;
  else if (c.oi < 1000 && c.volume < 2000) s *= 0.8;
  return s;
}

/** Responsiveness fit — favour ~0.55 delta (moves with the underlying, keeps gamma). */
function deltaFit(absDelta) { return clamp(100 - Math.abs(absDelta - 0.55) * 180, 40, 100); }

/** Linear-interpolate |delta| at an arbitrary price across the strike grid. */
function interpDelta(pool, price) {
  const pts = pool.map(c => ({ k: c.strike, d: Math.abs(c.delta) })).sort((a, b) => a.k - b.k);
  if (price <= pts[0].k) return pts[0].d;
  if (price >= pts[pts.length - 1].k) return pts[pts.length - 1].d;
  for (let i = 1; i < pts.length; i++) {
    if (price <= pts[i].k) {
      const t = (price - pts[i - 1].k) / (pts[i].k - pts[i - 1].k);
      return pts[i - 1].d + t * (pts[i].d - pts[i - 1].d);
    }
  }
  return pts[pts.length - 1].d;
}

const WEIGHTS = { conf: 0.45, delta: 0.25, liq: 0.20, pop: 0.10 };

export function selectTrades(verdict, contracts, opts = {}) {
  const cfg = { maxCandidates: 6, spreadWidthStrikes: 2, ...opts };
  if (!verdict || verdict.bias === 'NEUTRAL') {
    return { standAside: true, candidates: [], note: 'Consensus is NEUTRAL — stand aside, no option trade.' };
  }
  const wantType = verdict.side === 'LONG_CALLS' ? 'call' : 'put';
  const conf = verdict.confidence;
  const pool = contracts
    .filter(c => c.type === wantType && c.mark > 0 && c.ask > 0)
    .sort((a, b) => a.strike - b.strike);
  if (pool.length === 0) return { standAside: false, candidates: [], note: `No usable ${wantType} quotes.` };

  const candidates = [];

  // ---- Long singles (the value-flip vehicle) ------------------------------
  for (const c of pool) {
    const ad = Math.abs(c.delta);
    if (ad < 0.35 || ad > 0.72) continue;
    const liq = liqScore(c), df = deltaFit(ad), pop = c.popLong * 100;
    const score = clamp(WEIGHTS.conf * conf + WEIGHTS.delta * df + WEIGHTS.liq * liq + WEIGHTS.pop * pop, 0, 95);
    candidates.push({
      structure: `LONG ${c.strike}${wantType[0].toUpperCase()}`,
      kind: 'long_single',
      legs: [{ action: 'BUY', type: c.type, strike: c.strike }],
      cost: round(c.mark * 100), maxLoss: round(c.mark * 100), maxProfit: 'uncapped',
      breakeven: c.breakeven, delta: round(ad, 3), iv: round(c.iv, 3),
      popExpiry: round(c.popLong, 3),
      confidence: Math.round(score),
      why: `Δ${ad.toFixed(2)} responsive, ${liq >= 85 ? 'tight' : liq >= 65 ? 'ok' : 'wide'} spread, expiry-POP ${(c.popLong * 100).toFixed(0)}% (exit earlier on a value flip).`,
    });
  }

  // ---- Debit verticals (defined risk; caps the value-flip upside) ----------
  for (let i = 0; i < pool.length; i++) {
    const long = pool[i];
    const ad = Math.abs(long.delta);
    if (ad < 0.45 || ad > 0.65) continue;
    const short = pool[i + cfg.spreadWidthStrikes];
    if (!short) continue;
    const debit = long.mark - short.mark;
    if (debit <= 0) continue;
    const width = Math.abs(short.strike - long.strike);
    const maxProfit = (width - debit) * 100;
    const breakeven = wantType === 'call' ? long.strike + debit : long.strike - debit;
    const rr = maxProfit / (debit * 100);
    const popBE = interpDelta(pool, breakeven); // ~P(underlying past breakeven)
    const liq = (liqScore(long) + liqScore(short)) / 2;
    const score = clamp(
      WEIGHTS.conf * conf + WEIGHTS.delta * deltaFit(ad) + WEIGHTS.liq * liq + WEIGHTS.pop * (popBE * 100)
      + Math.min(8, rr * 6), // small bonus for R/R
      0, 95);
    candidates.push({
      structure: `DEBIT ${long.strike}/${short.strike}${wantType[0].toUpperCase()}`,
      kind: 'debit_vertical',
      legs: [{ action: 'BUY', type: long.type, strike: long.strike }, { action: 'SELL', type: short.type, strike: short.strike }],
      cost: round(debit * 100), maxLoss: round(debit * 100), maxProfit: round(maxProfit),
      breakeven: round(breakeven), delta: round(ad, 3),
      rr: round(rr, 2), popBreakeven: round(popBE, 3),
      confidence: Math.round(score),
      why: `Defined risk $${round(debit * 100)} → $${round(maxProfit)} (R/R ${rr.toFixed(2)}), ~${(popBE * 100).toFixed(0)}% past BE. Caps the upside — secondary to a long for pure value-flip gains.`,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  return {
    standAside: false,
    side: verdict.side, bias: verdict.bias, consensusConfidence: conf,
    candidates: candidates.slice(0, cfg.maxCandidates),
    note: candidates.length ? null : `No ${wantType} strikes in the responsive delta band.`,
  };
}
