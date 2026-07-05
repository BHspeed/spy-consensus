/**
 * Leveraged-ETF swing scorer — strategy #5.
 *
 * The play: buy a 2x/3x ETF at an OVERSOLD LOW (a "lowest point of interest"),
 * hold days-to-weeks for the bounce. Leverage amplifies — a ~5% parent bounce is
 * ~10% on a 2x, ~15% on a 3x. We do NOT chase; we want the dip bottoms:
 * oversold (low RSI) + sitting near a recent low + already pulled back hard, and
 * ideally the longer trend still up (buy-the-dip, not catch-a-falling-knife).
 *
 * Pure. bars = daily [{c,h,l}] (oldest→newest). meta = {etf, parent, lev}.
 */
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function atrPct(bars, n = 14) {
  const m = Math.min(n, bars.length - 1);
  if (m < 2) return 3;
  let s = 0;
  for (let i = bars.length - m; i < bars.length; i++) {
    s += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  }
  return (s / m) / bars[bars.length - 1].c * 100;
}
const sma = (arr, n) => { const s = arr.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; };

export function scoreLevSwing(bars, meta) {
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const price = closes[closes.length - 1];
  const look = Math.min(20, bars.length);
  const recentHigh = Math.max(...highs.slice(-look));
  const recentLow = Math.min(...lows.slice(-look));

  const r = rsi(closes, 14);
  const pullbackPct = r1(((recentHigh - price) / recentHigh) * 100);
  const distToLowPct = r1(((price - recentLow) / recentLow) * 100);
  const a = atrPct(bars, 14);
  const sma50 = sma(closes, Math.min(50, closes.length));
  const aboveMA = price > sma50;

  // FLOOR: the multi-month low (the strongest tell). A 2x/3x near a floor it hasn't
  // broken in months is a high-odds bounce — that's the core of this strategy.
  const floor = Math.min(...lows);
  const distToFloorPct = r1(((price - floor) / floor) * 100);
  const nearFloor = distToFloorPct <= 10 && r < 58;

  // Buy either at the multi-month floor OR a fresh oversold 20-day-low dip.
  const oversoldDip = r < 45 && distToLowPct < 8 && pullbackPct > 12;
  const qualifies = nearFloor || oversoldDip;
  const score = r1(
    Math.max(0, 12 - distToFloorPct) * 3  // near the multi-month FLOOR = strongest
    + (42 - Math.min(r, 42)) * 1.2        // more oversold
    + Math.max(0, 6 - distToLowPct) * 1.5 // near the recent low
    + Math.min(pullbackPct, 40) * 0.3     // deeper pullback = more to recover
    + (aboveMA ? 4 : 0),                  // dip in an uptrend > falling knife
  );

  const targetPct = clamp(r1(a * 2.5), 8, 25);   // a bounce ≈ a few daily ATRs (amplified)
  const stopPct = clamp(r1(a * 1.5), 6, 15);
  return {
    etf: meta.etf, parent: meta.parent, lev: meta.lev, price: r2(price),
    rsi: Math.round(r), pullbackPct, distToLowPct, atrPct: r1(a), aboveMA, qualifies, score,
    floor: r2(floor), distToFloorPct, nearFloor,
    targetPct, target: r2(price * (1 + targetPct / 100)),
    stopPct, stop: r2(price * (1 - stopPct / 100)),
    parentMovePct: r1(targetPct / meta.lev), // implied parent move for the target
  };
}

/** Rank the qualifying oversold-bounce setups. */
export function rankLevSwings(scored) {
  return [...scored].filter((s) => s.qualifies).sort((a, b) => b.score - a.score);
}
