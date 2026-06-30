/**
 * Aggregate stats over the run log (logs/spy_runs.jsonl). Pure: takes parsed
 * records, returns a summary object. Two record kinds live in the same file:
 *
 *   run   — written by `run.mjs --log`: has `consensus` + `decision`.
 *   trade — appended when a real fill is recorded: has numeric `pnl`
 *           (and `structure`, `consensusDir`, `status`, timestamps).
 *
 * Trade record shape (for when fills are reconciled from Robinhood):
 *   { type:'trade', linkedRunAt, structure:'DEBIT 741/745C', side:'A'|'B',
 *     entry, exit, pnl, pnlPct, status:'open'|'closed',
 *     openedAt, closedAt, consensusDir, spotAtEntry, spotAtExit }
 */

const isRun = (r) => r && r.consensus && r.decision !== undefined;
const isTrade = (r) => r && (r.type === 'trade' || typeof r.pnl === 'number');
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (v) => Math.round(v * 10) / 10;

export function summarize(records) {
  const runs = records.filter(isRun);
  const trades = records.filter(isTrade);
  const byTime = [...runs].sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt));

  // ---- run-level stats -----------------------------------------------------
  const dec = { IDEAS: 0, STAND_ASIDE: 0, NO_CHAIN: 0 };
  const byDir = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  const ideaConfs = [];
  for (const r of runs) {
    dec[r.decision] = (dec[r.decision] || 0) + 1;
    const d = r.consensus.dir; if (byDir[d] != null) byDir[d]++;
    if (r.decision === 'IDEAS') ideaConfs.push(r.consensus.confidence);
  }

  // ---- direction hit-rate (proxy: move to the NEXT logged spot) ------------
  const TH = 0.1; // % move to count as a real direction (filters noise)
  let right = 0, wrong = 0, flat = 0;
  const confR = [], confW = [];
  for (let i = 0; i < byTime.length; i++) {
    const r = byTime[i];
    if (!['UP', 'DOWN'].includes(r.consensus.dir) || typeof r.spot !== 'number') continue;
    const later = byTime.slice(i + 1).find(x => typeof x.spot === 'number' && x.spot !== r.spot);
    if (!later) continue;
    const chg = ((later.spot - r.spot) / r.spot) * 100;
    if (Math.abs(chg) <= TH) { flat++; continue; }
    const correct = r.consensus.dir === 'UP' ? chg > 0 : chg < 0;
    if (correct) { right++; confR.push(r.consensus.confidence); }
    else { wrong++; confW.push(r.consensus.confidence); }
  }

  // ---- trade outcomes ------------------------------------------------------
  const closed = trades.filter(t => t.status !== 'open' && typeof t.pnl === 'number');
  const open = trades.filter(t => t.status === 'open');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const kindOf = (t) => /CREDIT/i.test(t.structure || '') ? 'credit'
    : /DEBIT/i.test(t.structure || '') ? 'debit'
      : /LONG/i.test(t.structure || '') ? 'long' : 'other';
  const byStructure = {};
  for (const t of closed) {
    const k = kindOf(t);
    (byStructure[k] ||= { n: 0, wins: 0, pnl: 0 });
    byStructure[k].n++; byStructure[k].pnl += t.pnl; if (t.pnl > 0) byStructure[k].wins++;
  }
  for (const k of Object.keys(byStructure)) {
    byStructure[k].winRatePct = pct(byStructure[k].wins, byStructure[k].n);
    byStructure[k].avgPnl = r1(byStructure[k].pnl / byStructure[k].n);
  }
  const sortedByPnl = [...closed].sort((a, b) => b.pnl - a.pnl);

  return {
    period: { from: byTime[0]?.loggedAt || null, to: byTime[byTime.length - 1]?.loggedAt || null },
    runs: {
      total: runs.length, ideas: dec.IDEAS, standAside: dec.STAND_ASIDE, noChain: dec.NO_CHAIN,
      byDir, avgConfidenceIdeas: r1(avg(ideaConfs)),
    },
    direction: {
      comparable: right + wrong + flat, right, wrong, flat,
      hitRatePct: pct(right, right + wrong),
      avgConfWhenRight: r1(avg(confR)), avgConfWhenWrong: r1(avg(confW)),
    },
    trades: {
      closed: closed.length, open: open.length,
      wins: wins.length, losses: losses.length, winRatePct: pct(wins.length, closed.length),
      totalPnl: r1(closed.reduce((s, t) => s + t.pnl, 0)),
      avgPnl: r1(avg(closed.map(t => t.pnl))),
      byStructure,
      best: sortedByPnl[0] || null, worst: sortedByPnl[sortedByPnl.length - 1] || null,
    },
  };
}
