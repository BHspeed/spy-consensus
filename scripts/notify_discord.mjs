#!/usr/bin/env node
/**
 * Post a message to the auto-trade Discord channel via webhook.
 *
 * Webhook resolution (first hit wins):
 *   1. $DISCORD_WEBHOOK_URL           (preferred — keeps the secret out of git)
 *   2. data/discord_webhook.txt       (committed so unattended cycles can post
 *                                       after the container re-clones the repo)
 *
 * Usage:
 *   node scripts/notify_discord.mjs "message text"
 *   node scripts/notify_discord.mjs --file path/to/message.txt
 *   echo "text" | node scripts/notify_discord.mjs           # from stdin
 *   node scripts/notify_discord.mjs --title "Cycle 10:30 ET" --file summary.txt
 *
 * Wraps the body in a ``` code block and truncates to Discord's 2000-char limit.
 */
import { readFileSync } from 'node:fs';

function resolveWebhook() {
  if (process.env.DISCORD_WEBHOOK_URL) return process.env.DISCORD_WEBHOOK_URL.trim();
  try { return readFileSync('data/discord_webhook.txt', 'utf8').trim(); } catch { return null; }
}

const args = process.argv.slice(2);
function optVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const title = optVal('--title');
const filePath = optVal('--file');

let body;
if (filePath) {
  body = readFileSync(filePath, 'utf8');
} else {
  const literal = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--title' && args[i - 1] !== '--file').join(' ');
  body = literal || readFileSync(0, 'utf8'); // fd 0 = stdin
}

const webhook = resolveWebhook();
if (!webhook) {
  console.error('notify_discord: no webhook (set DISCORD_WEBHOOK_URL or data/discord_webhook.txt)');
  process.exit(1);
}

// Assemble; Discord hard-caps content at 2000 chars.
const header = title ? `**${title}**\n` : '';
const fence = '```';
const budget = 2000 - header.length - fence.length * 2 - 2;
const trimmed = body.length > budget ? body.slice(0, budget - 3) + '...' : body;
const content = `${header}${fence}\n${trimmed}\n${fence}`;

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content }),
});
const text = await res.text();
if (!res.ok) {
  console.error('notify_discord: FAILED', res.status, text.slice(0, 300));
  process.exit(1);
}
console.log('notify_discord: ok', res.status);
