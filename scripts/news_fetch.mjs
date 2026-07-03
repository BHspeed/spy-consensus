#!/usr/bin/env node
/**
 * Fetch market + company news from Finnhub → data/news_feed.json.
 *
 * Runs ONLY in the news-fetch GitHub Action (has internet + the NEWS_API_KEY
 * secret). The cloud routine can't reach the internet, so this is how headlines
 * get into the repo for the routine to analyze. Requires env NEWS_API_KEY.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.env.NEWS_API_KEY;
if (!KEY) { console.error('NEWS_API_KEY not set'); process.exit(1); }

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const majors = (readJSON('data/news_watch.json', {}).majors) || [];
const swings = (() => {
  try {
    return [...new Set(readFileSync('data/swings_active.jsonl', 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((p) => !p.status || p.status === 'open').map((p) => p.symbol))];
  } catch { return []; }
})();
const syms = [...new Set([...majors, ...swings])].filter((s) => s !== 'SPY').slice(0, 12); // SPY: no company-news endpoint

const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
const norm = (arr, tickers) => (arr || []).filter((x) => x && x.headline)
  .map((x) => ({ headline: x.headline, summary: (x.summary || '').slice(0, 280), source: x.source, url: x.url, datetime: x.datetime, tickers }));
const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };

const items = [];
try { items.push(...norm((await getJSON(`https://finnhub.io/api/v1/news?category=general&token=${KEY}`)).slice(0, 20), ['general'])); }
catch (e) { console.error('general news err:', e.message); }
for (const s of syms) {
  try { items.push(...norm((await getJSON(`https://finnhub.io/api/v1/company-news?symbol=${s}&from=${from}&to=${today}&token=${KEY}`)).slice(0, 4), [s])); }
  catch (e) { console.error(s, 'err:', e.message); }
  await new Promise((r) => setTimeout(r, 250)); // be gentle with the rate limit
}

mkdirSync('data', { recursive: true });
writeFileSync('data/news_feed.json', JSON.stringify({ fetched_at: new Date().toISOString(), items }));
console.log(`wrote ${items.length} items across ${syms.length + 1} feeds`);
