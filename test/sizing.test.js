import test from 'node:test';
import assert from 'node:assert/strict';
import { computePositionSize } from '../src/engine/rules.js';

const cfg = {
  riskPerTrade: 0.01,
  stopAtrMult: 1.5,
  maxNotionalPct: 0.25,
};

test('risk-based sizing: qty = (equity * 1%) / (1.5 * ATR)', () => {
  // equity 1000 -> risk $10; ATR 4 -> stop distance 6; qty = 10/6
  const { qty, stopDist, capped } = computePositionSize(1000, 50, 4, cfg);
  assert.ok(Math.abs(stopDist - 6) < 1e-9);
  assert.ok(Math.abs(qty - 10 / 6) < 1e-9);
  assert.equal(capped, false);
});

test('notional is capped at 25% of equity', () => {
  // equity 1000, price 60000, ATR 100 -> risk qty = 10/150 = 0.0667 BTC
  // -> notional $4000, way over the $250 cap -> qty = 250/60000
  const { qty, notional, capped } = computePositionSize(1000, 60000, 100, cfg);
  assert.equal(capped, true);
  assert.ok(Math.abs(qty - 250 / 60000) < 1e-12);
  assert.ok(Math.abs(notional - 250) < 1e-9);
});

test('degenerate inputs produce zero size', () => {
  assert.equal(computePositionSize(1000, 50, 0, cfg).qty, 0);
  assert.equal(computePositionSize(0, 50, 4, cfg).qty, 0);
  assert.equal(computePositionSize(1000, 0, 4, cfg).qty, 0);
});
