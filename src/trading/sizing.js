/**
 * Position sizing — allocates a small cash balance across ranked candidates,
 * mixing high-cap (fractional shares → market order) and low-priced (whole
 * shares → marketable limit), while respecting: cash buffer, settled-cash gate,
 * max positions, per-tier split, and per-position caps.
 *
 * Pure: takes the account snapshot + ranked picks, returns intended entries.
 *
 * @param {Object} args
 * @param {number} args.equity        total account value (USD)
 * @param {number} args.settledCash   cash cleared for use (cash-account GFV gate)
 * @param {Array}  args.openPositions [{symbol, tier}] currently held
 * @param {Array}  args.picks         ranked candidates from screen()
 * @param {Object} cfg
 * @returns {{entries:Array, notes:string[]}}
 *   entry = {symbol, tier, usd, shares, orderType:'market'|'limit'}
 */
export function planEntries({ equity, settledCash, openPositions = [], picks = [] }, cfg) {
  const notes = [];
  const s = cfg.sizing;

  // Capital we're allowed to deploy this cycle.
  const bufferUsd = equity * (s.cashBufferPct / 100);
  let deployable = Math.max(0, equity - bufferUsd);
  if (cfg.settlement.onlyDeploySettledCash) {
    deployable = Math.min(deployable, Math.max(0, settledCash - bufferUsd));
  }
  const maxPositionUsd = equity * (s.maxPositionPct / 100);

  const freeSlots = s.maxPositions - openPositions.length;
  if (freeSlots <= 0) { notes.push('No free position slots.'); return { entries: [], notes }; }
  if (deployable < s.minOrderUsd) { notes.push(`Deployable $${round2(deployable)} < min order $${s.minOrderUsd}.`); return { entries: [], notes }; }

  // Per-tier target counts, then subtract what's already held in each tier.
  const heldByTier = tally(openPositions.map(p => p.tier));
  const targetByTier = {
    highcap: Math.round(s.maxPositions * s.tierSplit.highcap),
    lowpriced: Math.round(s.maxPositions * s.tierSplit.lowpriced),
  };
  const remainingByTier = {
    highcap: Math.max(0, targetByTier.highcap - (heldByTier.highcap || 0)),
    lowpriced: Math.max(0, targetByTier.lowpriced - (heldByTier.lowpriced || 0)),
  };

  const held = new Set(openPositions.map(p => p.symbol));
  const chosen = [];
  for (const c of picks) {
    if (chosen.length >= freeSlots) break;
    if (held.has(c.symbol)) continue;
    if (chosen.some(x => x.symbol === c.symbol)) continue;
    if (remainingByTier[c.tier] <= 0) continue;
    remainingByTier[c.tier] -= 1;
    chosen.push(c);
  }
  // Backfill any leftover slots ignoring the tier split if a tier ran dry.
  if (chosen.length < freeSlots) {
    for (const c of picks) {
      if (chosen.length >= freeSlots) break;
      if (held.has(c.symbol) || chosen.some(x => x.symbol === c.symbol)) continue;
      chosen.push(c);
    }
  }
  if (chosen.length === 0) { notes.push('No eligible candidates after tier/dup filters.'); return { entries: [], notes }; }

  // Spread deployable capital evenly across the chosen names, clamped per-position.
  const perPos = Math.min(maxPositionUsd, deployable / chosen.length);
  const entries = [];
  let cashLeft = deployable;

  for (const c of chosen) {
    const budget = Math.min(perPos, cashLeft);
    if (budget < s.minOrderUsd) { notes.push(`${c.symbol}: budget $${round2(budget)} < min $${s.minOrderUsd}, skipped.`); continue; }

    if (c.tier === 'highcap') {
      // Fractional shares → market order (RH fractional is market + RTH only).
      const shares = round6(budget / c.price);
      if (shares <= 0) continue;
      entries.push({ symbol: c.symbol, tier: c.tier, usd: round2(budget), shares, orderType: 'market' });
      cashLeft -= budget;
    } else {
      // Whole shares → marketable limit.
      const shares = Math.floor(budget / c.price);
      if (shares < 1) { notes.push(`${c.symbol}: $${round2(budget)} < 1 share @ ${c.price}, skipped.`); continue; }
      const cost = shares * c.price;
      entries.push({ symbol: c.symbol, tier: c.tier, usd: round2(cost), shares, orderType: 'limit' });
      cashLeft -= cost;
    }
  }
  return { entries, notes };
}

function tally(arr) { return arr.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}); }
function round2(v) { return Math.round(v * 100) / 100; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
