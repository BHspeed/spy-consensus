#!/usr/bin/env node
/**
 * News prep for the News/Earnings channel.
 *
 * `data/news_feed.json` is written by the news-fetch GitHub Action (Finnhub, on
 * GitHub's internet). This script dedupes, lexicon-tags, and ranks the headlines
 * into a small shortlist the cloud agent turns into critical impact takes — the
 * agent supplies the judgment, this supplies the clean, bounded input.
 *
 *   node scripts/news.mjs prep [news_feed.json] [n]
 */
import { readFileSync } from 'node:fs';
import { lexiconSentiment, scoreNews, newsVsConsensus } from '../src/news/newsSignal.js';

const mode = process.argv[2];
const rest = process.argv.slice(3);
const path = rest.find((a) => a.endsWith('.json')) || 'data/news_feed.json';
const N = +(rest.find((a) => /^\d+$/.test(a)) || 12);

let feed;
try { feed = JSON.parse(readFileSync(path, 'utf8')); } catch { console.log('(no news feed available)'); process.exit(0); }
const items = feed.items || [];

if (mode === 'prep') {
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = (it.headline || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  const tagged = uniq.map((it) => {
    const s = lexiconSentiment(`${it.headline} ${it.summary || ''}`);
    return { ...it, tag: s > 0.05 ? 'bull' : s < -0.05 ? 'bear' : 'neutral', s };
  }).sort((a, b) => (b.datetime || 0) - (a.datetime || 0) || Math.abs(b.s) - Math.abs(a.s));

  const net = scoreNews(uniq.map((it) => ({ title: `${it.headline} ${it.summary || ''}`, source: it.source })));
  console.log(`NET TONE: ${net.label} · ${uniq.length} headlines`);
  tagged.slice(0, N).forEach((it, i) => {
    const tk = it.tickers && it.tickers.length && it.tickers[0] !== 'general' ? it.tickers.join(',') : 'market';
    console.log(`${i + 1}. [${it.tag}] ${it.headline} — ${tk} · ${it.source || '?'}`);
  });
  process.exit(0);
}

if (mode === 'factor') {
  // News decision-aid for one ticker: tone + how it lines up with the consensus.
  const sym = (rest[0] || '').toUpperCase();
  const dir = (rest[1] || '').toUpperCase();
  const has = (it) => (it.tickers || []).map((t) => String(t).toUpperCase()).includes(sym);
  const symItems = items.filter(has);
  const pool = symItems.length ? symItems : items.filter((it) => (it.tickers || []).includes('general')).slice(0, 6);

  const seen = new Set();
  const uniq = [];
  for (const it of pool) {
    const k = (it.headline || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  const net = scoreNews(uniq.map((it) => ({ title: `${it.headline} ${it.summary || ''}`, source: it.source })));
  const align = dir ? newsVsConsensus(net.score, dir) : null;
  const alignWord = !align ? ''
    : align === 'agrees' ? ` · agrees with the ${dir} read ✅`
      : align === 'disagrees' ? ` · DISAGREES with the ${dir} read ⚠️ (caution)`
        : ` · neutral to the ${dir} read`;
  const src = symItems.length ? `${sym}-specific` : 'market';

  console.log(`**📰 ${sym} news check** — ${net.label} (${src}, ${uniq.length} headlines)${alignWord}`);
  uniq.slice(0, 3).forEach((it) => {
    const s = lexiconSentiment(`${it.headline} ${it.summary || ''}`);
    const dot = s > 0.05 ? '🟢' : s < -0.05 ? '🔴' : '⚪';
    console.log(`${dot} ${it.headline}`);
  });
  process.exit(0);
}

console.error('usage: news.mjs prep [feed] [n]  |  news.mjs factor <SYMBOL> [DIR] [feed]');
process.exit(1);
