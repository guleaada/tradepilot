import test from 'node:test';
import assert from 'node:assert/strict';
import { entryAllowed, evaluateExit } from '../src/engine/rules.js';

const cfg = {
  regimeFlipConfidence: 70,
  regimeMinConfidence: 60,
  maxPositions: 2,
  rsiEntryMin: 45,
  rsiEntryMax: 70,
};

const position = { stop_price: 95, tp_price: 110 };

test('stop-loss fires at or below stop price', () => {
  assert.equal(evaluateExit(position, 94, null, cfg), 'stop');
  assert.equal(evaluateExit(position, 95, null, cfg), 'stop');
  assert.equal(evaluateExit(position, 96, null, cfg), null);
});

test('take-profit fires at or above tp price', () => {
  assert.equal(evaluateExit(position, 110, null, cfg), 'tp');
  assert.equal(evaluateExit(position, 120, null, cfg), 'tp');
});

test('bearish regime flip closes only at confidence >= 70', () => {
  assert.equal(evaluateExit(position, 100, { regime: 'bearish', confidence: 80 }, cfg), 'regime_flip');
  assert.equal(evaluateExit(position, 100, { regime: 'bearish', confidence: 60 }, cfg), null);
  assert.equal(evaluateExit(position, 100, { regime: 'chop', confidence: 90 }, cfg), null);
});

test('entry gate enforces every condition', () => {
  const good = {
    regime: { regime: 'bullish', confidence: 65, trade_allowed: true },
    price: 105,
    ema50_4h: 100,
    rsi1h: 55,
    hasOpen: false,
    openCount: 0,
    inCooldown: false,
    halted: false,
  };
  assert.equal(entryAllowed(good, cfg).ok, true);
  assert.equal(entryAllowed({ ...good, halted: true }, cfg).reason, 'risk_halt');
  assert.equal(entryAllowed({ ...good, hasOpen: true }, cfg).reason, 'position_open');
  assert.equal(entryAllowed({ ...good, openCount: 2 }, cfg).reason, 'max_positions');
  assert.equal(entryAllowed({ ...good, inCooldown: true }, cfg).reason, 'cooldown');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, regime: 'chop' } }, cfg).reason, 'regime_not_bullish');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, trade_allowed: false } }, cfg).reason, 'trade_not_allowed');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, confidence: 59 } }, cfg).reason, 'low_confidence');
  assert.equal(entryAllowed({ ...good, price: 99 }, cfg).reason, 'below_ema50_4h');
  assert.equal(entryAllowed({ ...good, rsi1h: 75 }, cfg).reason, 'rsi_out_of_band');
  assert.equal(entryAllowed({ ...good, rsi1h: 40 }, cfg).reason, 'rsi_out_of_band');
});
