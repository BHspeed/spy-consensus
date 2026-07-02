/**
 * News sentiment signal — EXPERIMENTAL. Deliberately SEPARATE from the core
 * consensus (src/consensus/ is not touched). This produces a single market-news
 * score in [-1, +1]; we track it alongside predictions/outcomes to learn whether
 * it has any edge BEFORE it is ever allowed to affect a call.
 *
 * Two ways to feed it:
 *  - scored items: [{ title, sentiment:-1..1, weight?, source?, when? }] — e.g.
 *    from a provider like Finnhub, or the agent's own read of each headline.
 *  - raw titles only: sentiment is filled by a tiny finance lexicon (crude
 *    deterministic fallback, good enough for a prototype).
 */

const BULL = ['surge', 'rally', 'soar', 'jump', 'gains', 'gain', 'beat', 'record', 'all-time high', 'upgrade', 'optimism', 'strong', 'rebound', 'boom', 'tailwind', 'rate cut', 'cuts rates', 'soft landing', 'cooling inflation', 'stimulus', 'outperform'];
const BEAR = ['plunge', 'slump', 'sinks', 'falls', 'drop', 'miss', 'recession', 'fear', 'selloff', 'sell-off', 'downgrade', 'weak', 'warning', 'warns', 'crash', 'tariff', 'rate hike', 'hikes', 'hot inflation', 'layoff', 'default', 'crisis', 'tumble', 'slide', 'slump', 'underperform'];

const clamp = (v) => Math.max(-1, Math.min(1, v));
const round2 = (v) => Math.round(v * 100) / 100;

/** Crude lexicon sentiment of a headline in [-1, +1]. */
export function lexiconSentiment(text = '') {
  const t = ` ${text.toLowerCase()} `;
  let s = 0;
  for (const w of BULL) if (t.includes(w)) s += 1;
  for (const w of BEAR) if (t.includes(w)) s -= 1;
  return clamp(s / 2);
}

/**
 * Aggregate scored headlines into one market-news score.
 * @returns {{score:number,label:string,count:number,drivers:Array}}
 */
export function scoreNews(items = []) {
  const scored = items.filter(Boolean).map((it) => ({
    title: it.title || '',
    s: typeof it.sentiment === 'number' ? clamp(it.sentiment) : lexiconSentiment(it.title || ''),
    w: it.weight != null && it.weight > 0 ? it.weight : 1,
    source: it.source,
  }));
  if (!scored.length) return { score: 0, label: 'no-news', count: 0, drivers: [] };
  const tw = scored.reduce((a, x) => a + x.w, 0) || 1;
  const score = round2(scored.reduce((a, x) => a + x.s * x.w, 0) / tw);
  const nonZero = scored.filter((x) => x.s !== 0);
  const agree = nonZero.filter((x) => Math.sign(x.s) === Math.sign(score)).length;
  const agreement = nonZero.length ? agree / nonZero.length : 0;
  const label = Math.abs(score) < 0.15 ? 'neutral'
    : agreement < 0.6 ? (score > 0 ? 'mixed-bullish' : 'mixed-bearish')
      : score > 0 ? 'bullish' : 'bearish';
  const drivers = [...scored]
    .sort((a, b) => Math.abs(b.s * b.w) - Math.abs(a.s * a.w))
    .slice(0, 3)
    .map((x) => ({ title: x.title, sentiment: round2(x.s), source: x.source }));
  return { score, label, count: scored.length, drivers };
}

/**
 * How the news lines up with a consensus direction — the thing we TRACK
 * (does the call do better when news agrees?). Never used to change the call
 * during the prototype phase.
 */
export function newsVsConsensus(newsScore, consensusDir) {
  if (Math.abs(newsScore) < 0.15 || consensusDir === 'SIDEWAYS') return 'neutral';
  const newsDir = newsScore > 0 ? 'UP' : 'DOWN';
  return newsDir === consensusDir ? 'agrees' : 'disagrees';
}
