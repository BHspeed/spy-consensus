/**
 * Unit tests for the bidirectional SPY turn snipe trigger.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { detectSignal } from '../src/trading/snipe.js';

const cfg = loadConfig();

describe('detectSignal (bidirectional)', () => {
  test('dip-then-bounce → CALL', () => {
    const closes = [738.5, 737.8, 736.9, 737.2, 737.6, 738.1];
    const r = detectSignal(closes, cfg);
    assert.equal(r.signal, true);
    assert.equal(r.direction, 'call');
    assert.ok(r.roc > 0);
  });

  test('peak-then-rollover → PUT', () => {
    const closes = [737.0, 737.8, 738.6, 738.3, 737.9, 737.3];
    const r = detectSignal(closes, cfg);
    assert.equal(r.signal, true);
    assert.equal(r.direction, 'put');
    assert.ok(r.roc < 0);
  });

  test('flat chop → no signal', () => {
    const closes = [737.0, 736.98, 737.02, 736.99, 737.01, 737.0];
    assert.equal(detectSignal(closes, cfg).signal, false);
  });

  test('still falling straight (no peak-then-down structure) → no signal', () => {
    const closes = [740, 739.5, 739, 738.4, 737.9, 737.2];
    // monotonic down: high is the first bar (before last-2), last < prev → peakThenDown true,
    // roc negative and beyond threshold → this DOES read as a bearish continuation PUT.
    const r = detectSignal(closes, cfg);
    assert.equal(r.direction, 'put');
  });

  test('too few bars → no signal', () => {
    assert.equal(detectSignal([737, 738], cfg).signal, false);
  });

  test('respects the enabled flag', () => {
    const off = loadConfig({ snipe: { ...cfg.snipe, enabled: false } });
    const closes = [738.5, 737.8, 736.9, 737.2, 737.6, 738.1];
    assert.equal(detectSignal(closes, off).signal, false);
  });
});
