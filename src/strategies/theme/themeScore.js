/**
 * Thematic momentum/setup scorer — strategy #6 (Quantum & Nuclear basket).
 *
 * A curated-basket channel for a policy-catalyst theme. For each name we read
 * momentum + where it sits in its range and classify the state so the daily
 * brief is a leaderboard: who's leading, who's breaking out, who's a dip-buy in
 * an uptrend, who's weak. Not a single call — situational awareness on the theme.
 *
 * Pure. bars = daily [{c,h,l}] (oldest→newest). meta = {ticker, group, name}.
 */
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

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
const sma = (arr, n) => { const s = arr.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; };

export function scoreTheme(bars, meta) {
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const price = closes[closes.length - 1];
  const back = (n) => (closes.length > n ? r1(((price - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]) * 100) : 0);
  const chg5 = back(5);
  const chg21 = back(21);
  const high20 = Math.max(...highs.slice(-20));
  const distFromHigh20 = r1(((high20 - price) / high20) * 100);
  const r = rsi(closes, 14);
  const sma50 = sma(closes, Math.min(50, closes.length));
  const aboveMA = price > sma50;

  let state, tag;
  if (distFromHigh20 <= 1.5) { state = 'breakout'; tag = '🚀'; }            // at 20-day highs
  else if (aboveMA && r < 45) { state = 'dip-buy'; tag = '🟢'; }             // pullback in an uptrend
  else if (aboveMA && chg21 > 0) { state = 'leading'; tag = '🔥'; }          // trending up
  else if (!aboveMA && r < 38) { state = 'oversold'; tag = '🟠'; }           // beaten down — potential bottom / accumulate
  else if (!aboveMA) { state = 'weak'; tag = '🔴'; }                         // downtrend, not yet oversold
  else { state = 'neutral'; tag = '⚪'; }

  const score = r1(chg21 * 0.5 + chg5 * 1.2 + (aboveMA ? 12 : 0) + Math.max(0, 12 - distFromHigh20));
  return {
    ticker: meta.ticker, group: meta.group, name: meta.name, price: r2(price),
    rsi: Math.round(r), chg5, chg21, distFromHigh20, aboveMA, state, tag, score,
  };
}

/** Sort a scored basket best-momentum first. */
export const rankTheme = (scored) => [...scored].sort((a, b) => b.score - a.score);
