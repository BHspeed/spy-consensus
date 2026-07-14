/**
 * Trump Watch filter — flag MARKET-RELEVANT Truth Social posts and tag them.
 *
 * Trump posts a lot (mostly endorsements/politics); we only alert on the ones
 * that can move markets. Word-boundary matching so "war" doesn't fire on
 * "warren"/"award". Pure + testable.
 */
const CATS = [
  { tag: '⛽ Energy/Oil', words: ['oil', 'opec', 'energy', 'gasoline', 'drilling', 'hormuz', 'strait', 'pipeline', 'crude', 'natural gas', 'lng'] },
  { tag: '🏦 Fed/Rates', words: ['federal reserve', 'powell', 'interest rate', 'interest rates', 'rate cut', 'rate hike', 'basis points', 'the fed'] },
  { tag: '🌐 Tariffs/Trade', words: ['tariff', 'tariffs', 'trade deal', 'trade war', 'trade agreement', 'sanctions', 'import tax', 'exports'] },
  { tag: '💥 Geopolitics', words: ['iran', 'russia', 'ukraine', 'israel', 'blockade', 'missile', 'north korea', 'venezuela', 'taiwan', 'nato', 'ceasefire', 'airstrike'] },
  { tag: '📉 Markets/Econ', words: ['stock market', 'stocks', 'wall street', 'nasdaq', 's&p', 'the market', 'recession', 'inflation', 'unemployment', 'gdp', 'economy'] },
  { tag: '₿ Crypto', words: ['bitcoin', 'crypto', 'ethereum', 'digital asset'] },
  { tag: '🏢 Companies', words: ['nvidia', 'tesla', 'apple', 'boeing', 'tiktok', 'intel', 'semiconductor'] },
];
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// His endorsement/campaign posts recycle market words ("strengthen our Economy,
// lower Inflation, unleash Energy...") as boilerplate praise — pure political noise.
// Exclude them up front so they don't trip the keyword match.
const NOISE = /\b(endorse|endorsed|endorses|endorsement|approval rating|congressional district|for (congress|senate|governor|president)|running for|reelect|re-elect|primary|MAGA|America First Patriot)\b/i;

export function classify(text = '') {
  if (NOISE.test(text)) return { relevant: false, matched: [], excluded: 'political' };
  const hits = [];
  for (const c of CATS) {
    const m = c.words.filter((w) => new RegExp('\\b' + esc(w) + '\\b', 'i').test(text));
    if (m.length) hits.push({ tag: c.tag, matched: m });
  }
  if (!hits.length) return { relevant: false, matched: [] };
  hits.sort((a, b) => b.matched.length - a.matched.length);
  return { relevant: true, tag: hits[0].tag, tags: [...new Set(hits.map((h) => h.tag))], matched: hits.flatMap((h) => h.matched) };
}

export function formatAlert(post, text, c) {
  let et;
  try { et = new Date(post.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { et = new Date(post.created_at).toISOString(); }
  const body = text.length > 380 ? `${text.slice(0, 377)}…` : text;
  return [
    `🚨 **TRUMP WATCH — ${et} ET**  ·  ${c.tags.join(' · ')}`,
    body.split('\n').map((l) => `> ${l}`).join('\n'),
    `\n⚡ potential market mover — check your positions.${post.url ? `  ([post](${post.url}))` : ''}`,
  ].join('\n');
}
