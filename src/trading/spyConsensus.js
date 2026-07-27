/**
 * SPY consensus adapter — folds the repo's existing SPY direction-consensus
 * engine (src/consensus/engine.js, the "call-out" pipeline) into the auto-trader
 * as a confirming signal. The idea: don't take new longs when the broad-market
 * call-out is bearish, and flag high-conviction bullish call-outs so an option
 * play can be considered.
 *
 * Two entry points:
 *   - spySignalFromBars(input): run buildVerdict() on SPY bars, then normalize.
 *   - normalizeSignal(verdict): normalize an already-computed verdict (or a plain
 *     {bias, confidence, score} the live agent produced from the pipeline).
 */
import { buildVerdict } from '../consensus/engine.js';

/** Run the consensus engine on SPY bars and return a normalized signal. */
export function spySignalFromBars(input) {
  return normalizeSignal(buildVerdict(input));
}

/**
 * Normalize a consensus verdict into an auto-trader signal.
 * @param {{bias:string, confidence:number, score?:number}} verdict
 * @returns {{bias, confidence, score, bullish, bearish, conviction, allowLongs, reason}}
 */
export function normalizeSignal(verdict) {
  if (!verdict || !verdict.bias) return null;
  const bias = verdict.bias;
  const confidence = verdict.confidence ?? 0;
  const bearish = /DOWN/.test(bias);
  const bullish = /UP/.test(bias);
  // Conviction ladder for downstream sizing / option routing.
  const conviction =
    bias === 'STRONG_UP' && confidence >= 60 ? 'strong' :
    bullish ? 'moderate' :
    bearish ? 'bearish' : 'neutral';
  return {
    bias,
    confidence,
    score: verdict.score ?? 0,
    bullish,
    bearish,
    conviction,
    allowLongs: !bearish,           // block new longs only on an outright bearish call
    reason: `SPY call-out ${bias} (${confidence}% conf)`,
  };
}

/**
 * Should we consider an options play this cycle? Pure decision helper — it does
 * NOT place anything. Gated hard on config.options.enabled (default false) and
 * on a strong bullish call-out. At a $100 account SPY calls are usually
 * unaffordable (one contract ≈ $100–300 premium), so this stays off until the
 * account is funded enough or a cheaper underlying is configured.
 * @returns {{consider:boolean, reason:string, target?:object}}
 */
export function optionIntent(spySig, cfg) {
  const o = cfg.options || {};
  if (!o.enabled) return { consider: false, reason: 'options disabled in config' };
  if (!spySig || !spySig.bullish) return { consider: false, reason: 'no bullish SPY call-out' };
  const rank = { none: 0, neutral: 0, moderate: 1, strong: 2 };
  if ((rank[spySig.conviction] || 0) < (rank[o.minConviction] || 2)) {
    return { consider: false, reason: `conviction ${spySig.conviction} < ${o.minConviction}` };
  }
  return {
    consider: true,
    reason: `strong SPY call-out (${spySig.bias}) — consider a long call`,
    target: { underlying: o.underlying, side: 'call', dte: o.dte, delta: o.targetDelta, maxPremiumUsd: o.maxPremiumUsd },
  };
}
