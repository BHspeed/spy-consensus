#!/usr/bin/env node
/**
 * Trump Watch — fetch Trump's Truth Social posts, alert on the market-relevant ones.
 *
 * Runs in the trump-watch GitHub Action (has internet + can reach the feed). Writes
 * outbox/trump-<id>.md for each NEW market-relevant post; the relay routes trump-*
 * to the Trump Watch channel. State (last-seen timestamp) in data/trump_seen.json.
 *
 *   node scripts/trump_watch.mjs         (Action: baseline on first run, else alert on new)
 *   node scripts/trump_watch.mjs --dry   (local: print alerts from the last 6h, no writes)
 *
 * Source: free CNN-mirrored archive of Trump's Truth Social posts (no key). It's a
 * third-party mirror — if it dies, swap TRUMP_FEED / fall back to the Finnhub feed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { classify, formatAlert } from '../src/strategies/trumpwatch/trumpFilter.js';

const FEED = process.env.TRUMP_FEED || 'https://ix.cnn.io/data/truth-social/truth_archive.json';
const SEEN = 'data/trump_seen.json';
const DRY = process.argv.includes('--dry');
const strip = (h) => String(h || '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&apos;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

(async () => {
  let arr;
  try { const r = await fetch(FEED); if (!r.ok) throw new Error('HTTP ' + r.status); arr = await r.json(); }
  catch (e) { console.error('feed fetch failed:', e.message); process.exit(0); } // don't fail the Action; retry next cycle

  const posts = (Array.isArray(arr) ? arr : []).filter((p) => p && p.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const seen = existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : {};

  if (!DRY && !seen.lastTs) { // first run: set the baseline, don't alert on history
    mkdirSync('data', { recursive: true });
    writeFileSync(SEEN, JSON.stringify({ lastTs: posts.length ? posts[posts.length - 1].created_at : new Date().toISOString() }));
    console.log('trump-watch: baseline set (no alerts on first run)');
    process.exit(0);
  }

  const sinceTs = DRY ? Date.now() - 6 * 3600 * 1000 : new Date(seen.lastTs).getTime();
  const fresh = posts.filter((p) => new Date(p.created_at).getTime() > sinceTs);

  mkdirSync('outbox', { recursive: true });
  mkdirSync('data', { recursive: true });
  let alerts = 0;
  for (const p of fresh) {
    const text = strip(p.content);
    if (!text) continue;
    const c = classify(text);
    if (!c.relevant) continue;
    const md = formatAlert(p, text, c);
    if (DRY) { console.log('\n----'); console.log(md); }
    else { writeFileSync(`outbox/trump-${String(p.id || new Date(p.created_at).getTime()).replace(/[^a-zA-Z0-9]/g, '')}.md`, md); }
    alerts++;
  }
  if (!DRY) writeFileSync(SEEN, JSON.stringify({ lastTs: fresh.length ? fresh[fresh.length - 1].created_at : seen.lastTs }));
  console.log(`trump-watch: ${fresh.length} new posts scanned, ${alerts} market-relevant alert(s)`);
})();
