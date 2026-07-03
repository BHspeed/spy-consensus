/**
 * Weekly single-leg option value-flip selector — strategy #4.
 *
 * The play: BUY one weekly call/put (not a spread) and scalp the PREMIUM value
 * flip — bank ~10%+ on the contract when a modest move flips it, don't wait to
 * be right on the strike. So we don't want lottery tickets (far-OTM, no delta)
 * or expensive deep-ITM (no leverage) — we want the sweet spot: enough delta to
 * move with the underlying, cheap enough that a normal move flips 10%+, liquid
 * enough to get out.
 *
 * opt = { symbol, type:'call'|'put', strike, expiry, dte, mark, bid, ask,
 *         delta, gamma, open_interest, volume }
 * ctx = { spot, expectedMovePct, dir:'UP'|'DOWN' }   (dir + move from consensus)
 */
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function scoreWeekly(opt, ctx) {
  const { spot, expectedMovePct = 0.4, dir = 'UP' } = ctx;
  const wantCall = dir !== 'DOWN';
  if ((wantCall && opt.type !== 'call') || (!wantCall && opt.type !== 'put')) return null;

  const mark = opt.mark || (opt.bid != null && opt.ask != null ? (opt.bid + opt.ask) / 2 : 0);
  if (!mark) return null;
  const absDelta = Math.abs(opt.delta || 0);
  const gamma = opt.gamma || 0;
  const move$ = spot * (expectedMovePct / 100);                 // favorable move magnitude
  const dPrem = absDelta * move$ + 0.5 * gamma * move$ * move$; // delta + gamma convexity
  const REALISM = 0.6;                                          // haircut for theta drag / IV compression
  const valueFlipPct = r1((dPrem / mark) * 100 * REALISM);      // est. % premium gain on that move

  const spreadPct = opt.ask && opt.bid ? r1(((opt.ask - opt.bid) / mark) * 100) : null;
  const moneyness = r1(((opt.strike - spot) / spot) * 100);     // 0 = ATM
  const liquid = (opt.open_interest >= 500 || opt.volume >= 200) && (spreadPct == null || spreadPct <= 12);

  // Value-flip sweet spot: delta 0.35-0.60, near the money, real weekly (not 0-DTE).
  const deltaFit = clamp(1 - Math.abs(absDelta - 0.47) / 0.35, 0, 1);
  const decayFlag = opt.dte != null && opt.dte <= 1;
  const qualifies = valueFlipPct >= 10 && liquid && absDelta >= 0.3 && absDelta <= 0.62
    && (opt.dte == null || (opt.dte >= 1 && opt.dte <= 8));

  const score = r1(
    clamp(valueFlipPct, 0, 40)          // leverage (capped so cheap lottery OTM can't win on % alone)
    + deltaFit * 12                     // reward the sweet-spot delta
    - (spreadPct ? spreadPct * 0.6 : 4) // penalize wide / unknown spreads
    - Math.max(0, Math.abs(moneyness) - 1.5) * 2 // penalize far from ATM
    - (decayFlag ? 10 : 0),             // 0-1 DTE decay risk
  );

  // value-flip exit plan (bank the flip; don't ride to expiry)
  const plan = { entry: r2(mark), arm: r2(mark * 1.10), take: r2(mark * 1.20), stop: r2(mark * 0.80) };

  return {
    symbol: opt.symbol, type: opt.type, strike: opt.strike, expiry: opt.expiry, dte: opt.dte,
    contract: `${opt.symbol} ${opt.expiry} ${opt.strike}${opt.type === 'call' ? 'C' : 'P'}`,
    mark: r2(mark), delta: r2(absDelta), valueFlipPct, spreadPct, moneyness, liquid, qualifies,
    score, plan,
  };
}

/** Pick the best N value-flip weeklies from a chain for the given direction. */
export function selectWeeklies(chain, ctx, n = 3) {
  return chain.map((o) => scoreWeekly(o, ctx)).filter(Boolean)
    .filter((o) => o.qualifies).sort((a, b) => b.score - a.score).slice(0, n);
}
