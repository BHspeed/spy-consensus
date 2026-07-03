/**
 * Earnings analyzer — the engine behind the News/Earnings channel.
 *
 * Given an EPS surprise (from Robinhood's earnings calendar/results) AND the
 * stock's price reaction, produce a CRITICAL read of how the print affects the
 * stock — not a naive "beat = good." The signal that matters is the interaction:
 *   - beat + stock up      → clean bullish (momentum)
 *   - beat + stock DOWN     → bearish divergence (priced in / soft guidance — the
 *                             tape disagrees with the headline; the real tell)
 *   - miss + stock up       → bullish divergence (whisper was worse / resilient)
 *   - miss + stock down     → clean bearish
 * The price reaction is the market's verdict; the EPS line is only the setup.
 *
 * Pure. priceReactionPct = % move attributable to the report (null if unknown).
 */
const r1 = (v) => Math.round(v * 10) / 10;

export function analyzeEarnings({ symbol, epsEstimate, epsActual, priceReactionPct = null, quarter, year }) {
  const est = Number(epsEstimate);
  const act = Number(epsActual);
  const hasEps = Number.isFinite(est) && Number.isFinite(act);
  const reported = hasEps && epsActual != null && epsActual !== '';

  const surprisePct = reported && est !== 0 ? r1(((act - est) / Math.abs(est)) * 100) : null;
  const beat = reported ? act >= est : null;
  const magnitude = surprisePct == null ? 'n/a'
    : Math.abs(surprisePct) >= 20 ? 'large'
      : Math.abs(surprisePct) >= 5 ? 'moderate' : 'slight';

  const rx = priceReactionPct == null ? null : r1(priceReactionPct);
  const reaction = rx == null ? 'pending'
    : rx >= 3 ? 'rewarded' : rx <= -3 ? 'punished' : 'muted';

  let verdict = 'pending', priceImpact = 'unclear', note = 'awaiting price reaction';
  if (!reported) {
    verdict = 'upcoming'; priceImpact = 'event risk';
    note = 'not yet reported — earnings risk on the calendar';
  } else if (beat && reaction === 'rewarded') {
    verdict = 'bullish'; priceImpact = 'positive';
    note = 'beat and the tape confirmed it — momentum to the upside';
  } else if (beat && reaction === 'punished') {
    verdict = 'bearish divergence'; priceImpact = 'negative';
    note = 'BEAT but sold off — beat was priced in or guidance/outlook was soft; the tape disagrees with the headline';
  } else if (beat && reaction === 'muted') {
    verdict = 'neutral-bullish'; priceImpact = 'slightly positive';
    note = 'beat with little follow-through — expectations were already high; no fresh fuel';
  } else if (beat === false && reaction === 'punished') {
    verdict = 'bearish'; priceImpact = 'negative';
    note = 'miss confirmed by selling — clean negative';
  } else if (beat === false && reaction === 'rewarded') {
    verdict = 'bullish divergence'; priceImpact = 'positive';
    note = 'MISSED but rallied — whisper was worse or forward guidance was strong; resilient';
  } else if (beat === false) {
    verdict = 'bearish'; priceImpact = 'slightly negative';
    note = 'miss with a muted reaction — watch for a delayed fade';
  } else if (beat && reaction === 'pending') {
    verdict = 'lean bullish'; priceImpact = 'tbd';
    note = `beat by ${surprisePct}% — price reaction will confirm or deny`;
  } else if (beat === false && reaction === 'pending') {
    verdict = 'lean bearish'; priceImpact = 'tbd';
    note = `missed by ${surprisePct}% — price reaction will confirm or deny`;
  }

  const q = quarter && year ? ` Q${quarter} ${year}` : '';
  const headline = `${symbol}${q}: ${beat == null ? '—' : beat ? 'beat' : 'MISS'}`
    + `${surprisePct != null ? ` ${surprisePct > 0 ? '+' : ''}${surprisePct}% EPS` : ''}`
    + `${rx != null ? `, stock ${rx > 0 ? '+' : ''}${rx}%` : ''} → ${verdict.toUpperCase()}`;

  return { symbol, quarter, year, epsEstimate: hasEps ? est : null, epsActual: reported ? act : null,
    surprisePct, beat, magnitude, reaction, verdict, priceImpact, note, priceReactionPct: rx, headline, reported };
}
