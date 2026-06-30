/**
 * Pure technical-indicator math for the direction-consensus engine.
 * Every function takes plain arrays/values and returns plain values — no I/O,
 * no chart access — so they are deterministic and unit-testable.
 *
 * Bar shape used throughout: { time, open, high, low, close, volume }
 */

/** Simple moving average of the last `period` values. Returns null if short. */
export function sma(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** Full EMA series (same length as input; leading values are seeded with SMA). */
export function emaSeries(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  // Seed with SMA of the first `period` points.
  if (values.length < period) {
    let run = values[0];
    out[0] = run;
    for (let i = 1; i < values.length; i++) { run = values[i] * k + run * (1 - k); out[i] = run; }
    return out;
  }
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Latest EMA value. */
export function ema(values, period) {
  const s = emaSeries(values, period);
  for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i];
  return null;
}

/** Wilder's RSI. Returns the latest value in 0..100, or null if short. */
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD. Returns { macd, signal, histogram } at the latest bar (or nulls). */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!closes || closes.length < slow + signalPeriod) return { macd: null, signal: null, histogram: null };
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const valid = macdLine.filter(v => v != null);
  const sig = emaSeries(valid, signalPeriod);
  const macdVal = valid[valid.length - 1];
  const signalVal = sig[sig.length - 1];
  return { macd: macdVal, signal: signalVal, histogram: macdVal - signalVal };
}

/** Average True Range (Wilder). Returns latest ATR or null. */
export function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += trs[i];
  a /= period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

/** ADX (Wilder) — trend strength 0..100, direction-agnostic. Null if short. */
export function adx(bars, period = 14) {
  if (!bars || bars.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smooth = (arr) => {
    let s = 0;
    for (let i = 0; i < period; i++) s += arr[i];
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pdi = 100 * pS[i] / trS[i];
    const mdi = 100 * mS[i] / trS[i];
    const denom = pdi + mdi;
    dx.push(denom === 0 ? 0 : 100 * Math.abs(pdi - mdi) / denom);
  }
  if (dx.length < period) return dx.length ? dx[dx.length - 1] : null;
  let a = 0;
  for (let i = 0; i < period; i++) a += dx[i];
  a /= period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
  return a;
}

/**
 * Swing structure over the last `lookback` bars: are we making higher highs /
 * higher lows (uptrend, +1) or lower highs / lower lows (downtrend, -1)?
 * Compares the most recent half-window's extremes to the prior half-window's.
 */
export function swingScore(bars, lookback = 20) {
  if (!bars || bars.length < lookback) return 0;
  const w = bars.slice(-lookback);
  const half = Math.floor(lookback / 2);
  const a = w.slice(0, half), b = w.slice(half);
  const hi = (arr) => Math.max(...arr.map(x => x.high));
  const lo = (arr) => Math.min(...arr.map(x => x.low));
  let s = 0;
  if (hi(b) > hi(a)) s += 0.5; else if (hi(b) < hi(a)) s -= 0.5;
  if (lo(b) > lo(a)) s += 0.5; else if (lo(b) < lo(a)) s -= 0.5;
  return s; // -1..+1
}

/** Clamp helper. */
export function clamp(v, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }
