#!/usr/bin/env node
/**
 * Turn raw Robinhood responses into the bundle that run.mjs expects.
 * Used by the scheduled cloud agent so the morning run is deterministic.
 *
 *   node scripts/build_bundle.mjs --daily=daily.json --hourly=hourly.json \
 *        --options=options.json --expiry=YYYY-MM-DD [--spot=NNN] [--out=bundle.json]
 *
 * Inputs:
 *  - daily.json / hourly.json : raw get_equity_historicals responses (SPY).
 *  - options.json : an array the agent assembles, each item a quote PLUS strike+type:
 *      [{ strike, type:'call'|'put', mark_price, bid_price, ask_price, delta,
 *         implied_volatility, open_interest, volume, break_even_price,
 *         chance_of_profit_long, chance_of_profit_short }, ...]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

function bars(resp) {
  const raw = resp?.data?.results?.[0]?.bars || [];
  return raw.filter(b => !b.interpolated).map(b => ({
    time: Math.floor(new Date(b.begins_at).getTime() / 1000),
    open: +b.open_price, high: +b.high_price, low: +b.low_price,
    close: +b.close_price, volume: +b.volume,
  }));
}
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// --drop-from=YYYY-MM-DD drops bars on/after that date — used to reconstruct
// the pre-open ("morning") view for the forward trace.
const dropFrom = arg('drop-from');
const keep = (b) => !dropFrom || dayOf(b.time) < dropFrom;
const daily = bars(load(arg('daily'))).filter(keep);
const hourly = bars(load(arg('hourly'))).filter(keep);

// If today's session is in the hourly feed but not yet a daily bar, synthesize it.
if (daily.length && hourly.length) {
  const lastDailyDay = dayOf(daily[daily.length - 1].time);
  const todays = hourly.filter(b => dayOf(b.time) > lastDailyDay);
  if (todays.length) {
    daily.push({
      time: todays[0].time,
      open: todays[0].open,
      high: Math.max(...todays.map(b => b.high)),
      low: Math.min(...todays.map(b => b.low)),
      close: todays[todays.length - 1].close,
      volume: todays.reduce((s, b) => s + b.volume, 0),
    });
  }
}

const prior = daily[daily.length - 2] || daily[daily.length - 1];
const last = daily[daily.length - 1];
const optionQuotes = load(arg('options')).map(q => ({ ...q, strike: +q.strike }));

const bundle = {
  symbol: arg('symbol', 'SPY'),
  asOf: arg('asof', new Date().toISOString()),
  expiry: arg('expiry'),
  lastPrice: +arg('spot', last ? last.close : 0),
  priorDay: { high: prior.high, low: prior.low, close: prior.close },
  daily, hourly, intraday: hourly.slice(-6),
  optionQuotes,
};

const out = arg('out', 'bundle.json');
writeFileSync(out, JSON.stringify(bundle));
console.log(`bundle → ${out}  (daily ${daily.length}, hourly ${hourly.length}, options ${optionQuotes.length}, spot ${bundle.lastPrice}, expiry ${bundle.expiry})`);
