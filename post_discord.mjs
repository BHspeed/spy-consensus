import { readFileSync } from 'node:fs';
const b = readFileSync('brief.txt', 'utf8');
const content = '**SPY morning brief — ' + new Date().toISOString().slice(0, 10) + '**\n```\n' + b.slice(0, 1850) + '\n```';
const res = await fetch('https://discord.com/api/webhooks/1521372099300687913/oGhlLzj3NvFWgMMW8xWE90CY2T56rs5pQjFEcTiZmyKbRwXBkpkK2Eu_Kus7mKoykNKj', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content }),
});
const text = await res.text();
console.log('discord', res.status, text);
