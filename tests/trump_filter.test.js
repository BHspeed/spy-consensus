import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, formatAlert } from '../src/strategies/trumpwatch/trumpFilter.js';

describe('trump watch filter', () => {
  test('market/geopolitical post is flagged with the right tag', () => {
    const c = classify('The United States will be the guardians of the Strait of Hormuz. We will blockade and charge a toll on oil shipments.');
    assert.ok(c.relevant);
    assert.match(c.tag, /Energy|Geopolitics/);
    assert.ok(c.matched.length > 0);
  });

  test('tariff / Fed posts are flagged', () => {
    assert.ok(classify('I am placing a 25% tariff on all imports from China.').relevant);
    assert.ok(classify('Jerome Powell must cut the interest rate NOW!').relevant);
  });

  test('pure political post is NOT flagged', () => {
    const c = classify('It is my Great Honor to endorse America First Patriot Dr. John Cowan for Congress!');
    assert.equal(c.relevant, false);
  });

  test('endorsement boilerplate with market words is excluded as political', () => {
    // his campaign template recycles Economy/Inflation/Energy — must NOT alert
    const c = classify('I fully endorse Steve! He will strengthen our Economy, crush Inflation, and unleash American Energy!');
    assert.equal(c.relevant, false);
    assert.equal(c.excluded, 'political');
  });

  test('word-boundary: no false positive from substrings', () => {
    // "toward"/"warren"/"reward" must not trip the geopolitics/energy words
    assert.equal(classify('Elizabeth Warren was toward the podium, a great reward for all.').relevant, false);
  });

  test('formatAlert renders the header, quoted body, and tag', () => {
    const c = classify('New tariffs on oil imports.');
    const md = formatAlert({ created_at: '2026-07-13T16:14:00Z', url: 'https://x' }, 'New tariffs on oil imports.', c);
    assert.match(md, /TRUMP WATCH/);
    assert.match(md, /^> /m);
    assert.match(md, /check your positions/);
  });
});
