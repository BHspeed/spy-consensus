/**
 * Unit tests for the SPY reversal snipe trigger.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/trading/config.js';
import { detectReversal } from '../src/trading/snipe.js';

const cfg = loadConfig();

describe('detectReversal', () => {
  test('fires on a dip-then-bounce while below the EMA', () => {
    // dip at the middle, then rising into the last bars
    const closes = [738.5, 737.8, 736.9, 737.2, 737.6, 738.1];
    const r = detectReversal(closes, true, cfg);
    assert.equal(r.signal, true);
    assert.ok(r.upRoc > 0);
  });

  test('does NOT fire while still falling', () => {
    const closes = [740, 739.5, 739, 738.4, 737.9, 737.2];
    assert.equal(detectReversal(closes, true, cfg).signal, false);
  });

  test('does NOT fire when SPY is above the EMA (not a dip to snipe)', () => {
    const closes = [738.5, 737.8, 736.9, 737.2, 737.6, 738.1];
    assert.equal(detectReversal(closes, false, cfg).signal, false);
  });

  test('needs a real up-move, not a flat drift', () => {
    const closes = [737.0, 736.9, 736.8, 736.82, 736.83, 736.85]; // +0.007% only
    assert.equal(detectReversal(closes, true, cfg).signal, false);
  });

  test('handles too-few bars gracefully', () => {
    assert.equal(detectReversal([737, 738], true, cfg).signal, false);
  });

  test('respects the enabled flag', () => {
    const off = loadConfig({ snipe: { ...cfg.snipe, enabled: false } });
    const closes = [738.5, 737.8, 736.9, 737.2, 737.6, 738.1];
    assert.equal(detectReversal(closes, true, off).signal, false);
  });
});
