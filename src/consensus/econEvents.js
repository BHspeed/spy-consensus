/**
 * Economic-event calendar — the LABEL source for report-day segmentation.
 *
 * High-impact scheduled releases (NFP jobs, CPI, FOMC) move the tape regardless
 * of the technical read, so we tag predictions made on those days and track them
 * as a SEPARATE cohort from normal days. This is a flag/label, never a vote in
 * the core consensus.
 *
 * Overrides in data/econ_events.json (date → label) always win; otherwise NFP is
 * inferred as the first Friday of the month. Keep the overrides file current for
 * CPI / FOMC and any holiday-shifted NFP (e.g. 2026-07-02 moved off the 7/3
 * holiday).
 */

/** Label for a given YYYY-MM-DD, or null if it's a normal day. */
export function eventFor(dateISO, overrides = {}) {
  if (overrides && overrides[dateISO]) return overrides[dateISO];
  const d = new Date(dateISO + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // NFP jobs report ≈ first Friday of the month.
  if (d.getUTCDay() === 5 && d.getUTCDate() <= 7) return 'NFP jobs report';
  return null;
}

export const isReportDay = (dateISO, overrides = {}) => eventFor(dateISO, overrides) != null;
