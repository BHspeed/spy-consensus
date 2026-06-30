/**
 * Direction-consensus engine.
 *
 * Takes OHLCV bars for multiple timeframes and produces a single, transparent
 * directional verdict with a confidence score and an explicit NEUTRAL /
 * stand-aside zone. Trend signals are weighted heavily on purpose: the engine
 * is designed to keep the trader aligned with the dominant flow and to refuse
 * to manufacture a signal when timeframes disagree.
 *
 * Input:
 *   {
 *     daily:    bars[],   // ~6 months of daily bars (required)
 *     hourly:   bars[],   // ~2 weeks of 1H bars  (optional but recommended)
 *     intraday: bars[],   // ~last few sessions of 5–30m bars (optional)
 *     priorDay: { high, low, close },  // optional — for location signal
 *     lastPrice: number,  // optional override; else last daily close
 *   }
 * Output: see buildVerdict() return shape.
 */
import { ema, sma, rsi, macd, atr, adx, swingScore, clamp } from './indicators.js';

// Each signal contributes a score in [-1, +1] and carries a weight.
// Weights are grouped so the daily trend dominates (~50% of total weight).
const WEIGHTS = {
  d_priceVsEma20: 1.4,
  d_ema20VsSma50: 1.4,
  d_sma50Slope: 1.2,
  d_rsi: 0.9,
  d_macdHist: 1.0,
  h_priceVsEma20: 1.0,
  h_rsi: 0.7,
  h_structure: 0.9,
  i_location: 0.8,
  i_momentum: 0.7,
};

const closesOf = (bars) => bars.map(b => b.close);

function pushSignal(signals, key, value, label) {
  if (value == null || Number.isNaN(value)) return;
  signals.push({ key, score: clamp(value), weight: WEIGHTS[key] ?? 1, label });
}

/** Slope of a series' last `n` points, normalised by price → roughly per-bar %. */
function slopeNorm(series, n, ref) {
  const vals = series.filter(v => v != null).slice(-n);
  if (vals.length < 2 || !ref) return 0;
  const perBar = (vals[vals.length - 1] - vals[0]) / (vals.length - 1);
  return clamp((perBar / ref) * 200); // scale so a ~0.5%/bar slope ≈ full signal
}

export function buildVerdict(input) {
  const { daily, hourly = [], intraday = [], priorDay, lastPrice } = input || {};
  if (!daily || daily.length < 50) {
    throw new Error('Need at least ~50 daily bars for a reliable consensus.');
  }
  const dCloses = closesOf(daily);
  const px = lastPrice ?? dCloses[dCloses.length - 1];
  const dAtr = atr(daily, 14) || (px * 0.01);
  const signals = [];

  // ---- Daily trend (the anchor) -------------------------------------------
  const dEma20 = ema(dCloses, 20);
  const dSma50 = sma(dCloses, 50);
  if (dEma20) pushSignal(signals, 'd_priceVsEma20', (px - dEma20) / (1.5 * dAtr), 'Price vs 20-EMA (D)');
  if (dEma20 && dSma50) pushSignal(signals, 'd_ema20VsSma50', ((dEma20 - dSma50) / dSma50) / 0.01, '20-EMA vs 50-SMA (D)');
  const sma50Series = daily.map((_, i) => sma(dCloses.slice(0, i + 1), 50));
  pushSignal(signals, 'd_sma50Slope', slopeNorm(sma50Series, 10, px), '50-SMA slope (D)');
  const dRsi = rsi(dCloses, 14);
  if (dRsi != null) pushSignal(signals, 'd_rsi', (dRsi - 50) / 25, `RSI ${dRsi.toFixed(0)} (D)`);
  const dMacd = macd(dCloses);
  if (dMacd.histogram != null) pushSignal(signals, 'd_macdHist', clamp(dMacd.histogram / (0.5 * dAtr)), 'MACD histogram (D)');

  // ---- Hourly (swing / 1–3 day horizon) -----------------------------------
  if (hourly.length >= 25) {
    const hCloses = closesOf(hourly);
    const hEma20 = ema(hCloses, 20);
    const hAtr = atr(hourly, 14) || (px * 0.004);
    if (hEma20) pushSignal(signals, 'h_priceVsEma20', (px - hEma20) / (1.5 * hAtr), 'Price vs 20-EMA (1H)');
    const hRsi = rsi(hCloses, 14);
    if (hRsi != null) pushSignal(signals, 'h_rsi', (hRsi - 50) / 25, `RSI ${hRsi.toFixed(0)} (1H)`);
    pushSignal(signals, 'h_structure', swingScore(hourly, 20), 'Swing structure (1H)');
  }

  // ---- Intraday location & momentum ---------------------------------------
  if (priorDay && priorDay.high > priorDay.low) {
    // Where is price within the prior day's range, mapped to [-1,+1] around mid,
    // with a breakout bonus for trading beyond the range.
    const mid = (priorDay.high + priorDay.low) / 2;
    const halfRange = (priorDay.high - priorDay.low) / 2;
    pushSignal(signals, 'i_location', clamp((px - mid) / halfRange), 'Position in prior-day range');
  }
  if (intraday.length >= 6) {
    const iCloses = closesOf(intraday);
    const n = Math.min(6, iCloses.length - 1);
    const roc = (iCloses[iCloses.length - 1] - iCloses[iCloses.length - 1 - n]) / iCloses[iCloses.length - 1 - n];
    const iAtrPct = (atr(intraday, 14) || px * 0.002) / px;
    pushSignal(signals, 'i_momentum', clamp(roc / (3 * iAtrPct)), `Last ${n}-bar momentum`);
  }

  // ---- Aggregate -----------------------------------------------------------
  const totalW = signals.reduce((s, x) => s + x.weight, 0) || 1;
  const weighted = signals.reduce((s, x) => s + x.score * x.weight, 0) / totalW; // -1..+1
  const score = Math.round(weighted * 100);

  // Agreement: how aligned are the signals with the net direction?
  const dir = Math.sign(weighted) || 0;
  const agreeW = signals.reduce((s, x) => s + (Math.sign(x.score) === dir ? x.weight : 0), 0);
  const agreement = Math.round((agreeW / totalW) * 100); // 0..100

  // Trend strength scales how much we trust the read.
  const dAdx = adx(daily, 14) || 15;
  const adxFactor = clamp((dAdx - 12) / 23, 0, 1); // ~12 = no trend, ~35 = strong

  // Confidence blends agreement, signal magnitude and trend strength.
  const magnitude = Math.min(1, Math.abs(weighted) / 0.6);
  const confidence = Math.round(100 * (0.5 * (agreement / 100) + 0.3 * magnitude + 0.2 * adxFactor));

  // Overextension: distance from 20-EMA in ATR units (mean-reversion risk).
  const overext = dEma20 ? (px - dEma20) / dAtr : 0;

  // ---- Bias bucket (the stand-aside gate) ---------------------------------
  let bias;
  const aScore = Math.abs(score);
  if (aScore < 20 || confidence < 45) bias = 'NEUTRAL';
  else if (aScore >= 50 && confidence >= 60) bias = score > 0 ? 'STRONG_UP' : 'STRONG_DOWN';
  else bias = score > 0 ? 'UP' : 'DOWN';

  // Daily-trend label (for counter-trend warnings on a proposed trade).
  const trendSignals = signals.filter(s => ['d_priceVsEma20', 'd_ema20VsSma50', 'd_sma50Slope'].includes(s.key));
  const trendNet = trendSignals.reduce((s, x) => s + x.score * x.weight, 0);
  const dominantTrend = trendNet > 0.15 ? 'UP' : trendNet < -0.15 ? 'DOWN' : 'FLAT';

  const warnings = [];
  if (Math.abs(overext) > 2.5) {
    warnings.push(`Price is ${overext.toFixed(1)} ATR from the 20-EMA — extended, mean-reversion risk on entries.`);
  }
  if (bias === 'NEUTRAL') warnings.push('Signals conflict — stand aside. This is a no-trade zone, not a coin flip.');

  const side = bias.includes('UP') ? 'LONG_CALLS' : bias.includes('DOWN') ? 'LONG_PUTS' : 'STAND_ASIDE';

  return {
    bias, score, confidence, dominantTrend,
    side,
    expectedMove: { dailyAtr: round2(dAtr), atrPct: round2((dAtr / px) * 100) },
    lastPrice: round2(px),
    adx: Math.round(dAdx),
    overextensionAtr: round2(overext),
    signals: signals.map(s => ({ ...s, score: round2(s.score) })),
    warnings,
    /**
     * Decide whether a *proposed* trade fights the consensus. Pass 'LONG'/'PUT'
     * or 'up'/'down'. Returns a warning string or null.
     */
    counterTrendCheck(proposed) {
      const wantUp = /up|long|call|buy/i.test(proposed);
      const wantDown = /down|short|put|sell/i.test(proposed);
      if (wantUp && dominantTrend === 'DOWN') return 'COUNTER-TREND: you are betting up against a DOWN daily trend.';
      if (wantDown && dominantTrend === 'UP') return 'COUNTER-TREND: you are betting down against an UP daily trend. (This is what cost you today.)';
      if ((wantUp && bias.includes('DOWN')) || (wantDown && bias.includes('UP'))) return 'Proposed trade opposes the current consensus bias.';
      return null;
    },
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
