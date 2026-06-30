/**
 * Option-selection layer.
 *
 * Turns a direction-consensus verdict + a live option chain into ranked trade
 * choices with confidence scores. Generates three structures per direction:
 *   - long single        (uncapped value-flip vehicle)
 *   - debit vertical      (buy-side spread: ride the move; defined risk)
 *   - credit vertical     (sell-side spread on the OTHER side: collect & wait)
 * UP  → call debit / put credit.   DOWN → put debit / call credit.
 *
 * Tuned for short holds with value-flip exits, so expiry-POP is de-emphasised
 * for the directional (debit) structures, but POP carries the credit structures
 * (those win by staying out of the money).
 *
 * Contract shape (normalise from Robinhood with fromRobinhood()):
 *   { type, strike, mark, bid, ask, delta, iv, oi, volume, breakeven, popLong, popShort }
 */

export function fromRobinhood(strike, type, q) {
  return {
    type, strike: +strike,
    mark: +q.mark_price, bid: +q.bid_price, ask: +q.ask_price,
    delta: +q.delta, iv: +q.implied_volatility,
    oi: +q.open_interest, volume: +q.volume,
    breakeven: +q.break_even_price,
    popLong: +q.chance_of_profit_long, popShort: +q.chance_of_profit_short,
  };
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => { const m = 10 ** d; return Math.round(v * m) / m; };

function liqScore(c) {
  if (!(c.mark > 0) || !(c.ask > 0)) return 0;
  const spreadPct = (c.ask - c.bid) / c.mark;
  let s = clamp(100 - spreadPct * 800);
  if (c.oi < 500 && c.volume < 1000) s *= 0.55;
  else if (c.oi < 1000 && c.volume < 2000) s *= 0.8;
  return s;
}
function deltaFit(absDelta) { return clamp(100 - Math.abs(absDelta - 0.55) * 180, 40, 100); }

/** Linear-interpolate |delta| (~P past strike) at an arbitrary price. */
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

const W = { conf: 0.45, delta: 0.25, liq: 0.20, pop: 0.10 };

export function selectTrades(verdict, contracts, opts = {}) {
  const cfg = { maxCandidates: 8, spreadWidthStrikes: 2, ...opts };
  if (!verdict || verdict.bias === 'NEUTRAL') {
    return { standAside: true, candidates: [], note: 'Consensus is NEUTRAL — stand aside, no option trade.' };
  }
  const up = verdict.side === 'LONG_CALLS';
  const byStrike = (a, b) => a.strike - b.strike;
  const calls = contracts.filter(c => c.type === 'call' && c.mark > 0 && c.ask > 0).sort(byStrike);
  const puts = contracts.filter(c => c.type === 'put' && c.mark > 0 && c.ask > 0).sort(byStrike);
  const debitPool = up ? calls : puts;   // directional, on the move side
  const creditPool = up ? puts : calls;  // income, opposite side
  const conf = verdict.confidence;
  const C = [];

  // ---- long singles (uncapped) --------------------------------------------
  for (const c of debitPool) {
    const ad = Math.abs(c.delta);
    if (ad < 0.35 || ad > 0.72) continue;
    const liq = liqScore(c);
    const score = clamp(W.conf * conf + W.delta * deltaFit(ad) + W.liq * liq + W.pop * c.popLong * 100, 0, 95);
    C.push({
      structure: `LONG ${c.strike}${c.type[0].toUpperCase()}`, kind: 'long_single',
      legs: [{ action: 'BUY', type: c.type, strike: c.strike }],
      cost: round(c.mark * 100), maxLoss: round(c.mark * 100), maxProfit: 'uncapped',
      breakeven: c.breakeven, delta: round(ad, 3), confidence: Math.round(score),
      why: `uncapped — gains as SPY moves your way, exit on the value flip.`,
    });
  }

  // ---- debit verticals (buy-side, directional) ----------------------------
  for (let i = 0; i < debitPool.length; i++) {
    const long = debitPool[i];
    const ad = Math.abs(long.delta);
    if (ad < 0.45 || ad > 0.65) continue;
    const short = up ? debitPool[i + cfg.spreadWidthStrikes] : debitPool[i - cfg.spreadWidthStrikes];
    if (!short) continue;
    const debit = long.mark - short.mark;
    if (debit <= 0) continue;
    const width = Math.abs(short.strike - long.strike);
    const maxProfit = (width - debit) * 100;
    const breakeven = up ? long.strike + debit : long.strike - debit;
    const rr = maxProfit / (debit * 100);
    const popBE = interpDelta(debitPool, breakeven);
    const liq = (liqScore(long) + liqScore(short)) / 2;
    const score = clamp(W.conf * conf + W.delta * deltaFit(ad) + W.liq * liq + W.pop * popBE * 100 + Math.min(8, rr * 6), 0, 95);
    C.push({
      structure: `DEBIT ${long.strike}/${short.strike}${long.type[0].toUpperCase()}`, kind: 'debit_vertical',
      legs: [{ action: 'BUY', type: long.type, strike: long.strike }, { action: 'SELL', type: short.type, strike: short.strike }],
      cost: round(debit * 100), maxLoss: round(debit * 100), maxProfit: round(maxProfit),
      breakeven: round(breakeven), delta: round(ad, 3), rr: round(rr, 2), confidence: Math.round(score),
      why: `buy-side: pay $${round(debit * 100)} to make up to $${round(maxProfit)} as SPY moves to ${short.strike}.`,
    });
  }

  // ---- credit verticals (sell-side, income, opposite side) ----------------
  for (let i = 0; i < creditPool.length; i++) {
    const short = creditPool[i];
    const ad = Math.abs(short.delta);
    if (ad < 0.22 || ad > 0.42) continue;
    const long = up ? creditPool[i - cfg.spreadWidthStrikes] : creditPool[i + cfg.spreadWidthStrikes];
    if (!long) continue;
    const credit = short.mark - long.mark;
    if (credit <= 0) continue;
    const width = Math.abs(short.strike - long.strike);
    const breakeven = up ? short.strike - credit : short.strike + credit;
    const maxProfit = credit * 100, maxLoss = (width - credit) * 100;
    const rr = maxProfit / maxLoss;
    const pop = short.popShort != null && !Number.isNaN(short.popShort) ? short.popShort : 1 - ad;
    const liq = (liqScore(short) + liqScore(long)) / 2;
    const score = clamp(0.45 * conf + 0.20 * liq + 0.25 * pop * 100 + Math.min(8, rr * 10), 0, 95);
    C.push({
      structure: `CREDIT ${short.strike}/${long.strike}${short.type[0].toUpperCase()}`, kind: 'credit_vertical',
      legs: [{ action: 'SELL', type: short.type, strike: short.strike }, { action: 'BUY', type: long.type, strike: long.strike }],
      credit: round(credit * 100), maxProfit: round(maxProfit), maxLoss: round(maxLoss),
      breakeven: round(breakeven), delta: round(ad, 3), rr: round(rr, 2), pop: round(pop, 3), confidence: Math.round(score),
      why: `sell-side: collect $${round(credit * 100)}, keep it if SPY stays ${up ? 'above' : 'below'} ${short.strike} (${Math.round(pop * 100)}% odds).`,
    });
  }

  C.sort((a, b) => b.confidence - a.confidence);
  return {
    standAside: false, side: verdict.side, bias: verdict.bias, consensusConfidence: conf,
    candidates: C.slice(0, cfg.maxCandidates), note: C.length ? null : 'No suitable strikes in range.',
  };
}
