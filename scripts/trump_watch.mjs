#!/usr/bin/env node
/**
 * Trump Watch — fetch Trump's Truth Social posts, alert on the market-relevant ones.
 *
 * Runs in the trump-watch GitHub Action (has internet). It POSTS alerts straight to
 * the Trump Watch webhook (NOT via the relay — a GITHUB_TOKEN push can't trigger the
 * relay workflow). State (last-seen timestamp) lives in data/trump_seen.json; the
 * Action commits only that. First run sets a baseline (no history spam).
 *
 *   node scripts/trump_watch.mjs         (Action: post new market alerts; needs TRUMP_WEBHOOK)
 *   node scripts/trump_watch.mjs --dry   (local: print alerts from the last 6h, no post/write)
 *
 * Source: free CNN-mirrored Truth Social archive (no key, ~5min fresh). Third-party
 * mirror — if it dies, swap TRUMP_FEED / fall back to the Finnhub feed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { classify, formatAlert } from '../src/strategies/trumpwatch/trumpFilter.js';

const FEED = process.env.TRUMP_FEED || 'https://ix.cnn.io/data/truth-social/truth_archive.json';
const WEBHOOK = process.env.TRUMP_WEBHOOK;
const SEEN = 'data/trump_seen.json';
const DRY = process.argv.includes('--dry');
const DISCLAIMER = '\n\n— _Educational only · not financial advice · trade your own risk._';
const strip = (h) => String(h || '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&apos;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(content) {
  const payload = JSON.stringify({ content: content.slice(0, 1990 - DISCLAIMER.length) + DISCLAIMER });
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (r.status < 300) return true;
      if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(((j.retry_after || 2)) * 1000 + 500); }
      else await sleep(1500 * i);
    } catch { await sleep(1500 * i); }
  }
  console.error('post failed after 4 tries');
  return false;
}

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

  let alerts = 0;
  for (const p of fresh) {
    const text = strip(p.content);
    if (!text) continue;
    const c = classify(text);
    if (!c.relevant) continue;
    const md = formatAlert(p, text, c);
    if (DRY || !WEBHOOK) { console.log('\n----\n' + md); }
    else { await post(md); await sleep(400); }
    alerts++;
  }
  if (!DRY) { mkdirSync('data', { recursive: true }); writeFileSync(SEEN, JSON.stringify({ lastTs: fresh.length ? fresh[fresh.length - 1].created_at : seen.lastTs })); }
  console.log(`trump-watch: ${fresh.length} new posts scanned, ${alerts} market-relevant alert(s) ${DRY ? '(dry)' : 'posted'}`);
})();
