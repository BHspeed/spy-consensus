#!/usr/bin/env node
/**
 * Demo: feed the UP consensus (as of 6/29) + real SPY 7/2 call quotes
 * (Robinhood, marks at 20:14 UTC / the close) into the option selector and
 * display the ranked, confidence-scored choices.
 */
import { selectTrades, fromRobinhood } from '../src/consensus/optionSelect.js';

// verdict slice from the consensus engine (npm run … spy_demo)
const verdict = { bias: 'UP', side: 'LONG_CALLS', confidence: 69, lastPrice: 741.10 };

// Real SPY 2026-07-02 call quotes.
const C = (strike, q) => fromRobinhood(strike, 'call', q);
const contracts = [
  C(738, { mark_price: 6.51, bid_price: 6.43, ask_price: 6.59, delta: 0.604, implied_volatility: 0.187, open_interest: 2194, volume: 7360, break_even_price: 744.51, chance_of_profit_long: 0.386 }),
  C(740, { mark_price: 5.18, bid_price: 5.12, ask_price: 5.24, delta: 0.540, implied_volatility: 0.179, open_interest: 7392, volume: 23974, break_even_price: 745.18, chance_of_profit_long: 0.359 }),
  C(741, { mark_price: 4.54, bid_price: 4.53, ask_price: 4.55, delta: 0.506, implied_volatility: 0.175, open_interest: 1857, volume: 7033, break_even_price: 745.54, chance_of_profit_long: 0.344 }),
  C(743, { mark_price: 3.42, bid_price: 3.41, ask_price: 3.43, delta: 0.433, implied_volatility: 0.167, open_interest: 2145, volume: 4224, break_even_price: 746.42, chance_of_profit_long: 0.309 }),
  C(745, { mark_price: 2.46, bid_price: 2.45, ask_price: 2.47, delta: 0.355, implied_volatility: 0.160, open_interest: 11600, volume: 16859, break_even_price: 747.46, chance_of_profit_long: 0.267 }),
];

const r = selectTrades(verdict, contracts);

console.log('\n════════  SPY OPTION CHOICES — 7/2 expiry, consensus UP (69%)  ════════');
if (r.standAside) { console.log(`  ${r.note}\n`); process.exit(0); }
console.log(`  side: ${r.side}   spot ~741.10   (ranked by confidence)\n`);
const conf = (c) => { const n = Math.round(c / 5); return '█'.repeat(n).padEnd(19, '·'); };
r.candidates.forEach((t, i) => {
  const pl = t.kind === 'debit_vertical'
    ? `cost $${t.cost}  max $${t.maxProfit} (R/R ${t.rr})  BE ${t.breakeven}`
    : `cost $${t.cost}  max uncapped  BE ${t.breakeven}`;
  console.log(`  ${i + 1}. ${t.structure.padEnd(16)} conf ${String(t.confidence).padStart(2)}% [${conf(t.confidence)}]`);
  console.log(`     ${pl}`);
  console.log(`     ${t.why}\n`);
});
console.log('  Note: long singles = uncapped value-flip upside; debit spreads = defined risk but capped.');
console.log('════════════════════════════════════════════════════════════════════════\n');
