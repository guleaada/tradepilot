import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePositionSize,
  dynamicRsiBounds,
  entryAllowed,
  isWeekendBlocked,
} from '../src/engine/rules.js';
import { volTargetScale } from '../src/engine/portfolio.js';

const cfg = {
  regimeMinConfidence: 60,
  regimeFlipConfidence: 70,
  maxPositions: 2,
  rsiEntryMin: 45,
  rsiEntryMax: 70,
  volumeFilterEnabled: true,
  volumeMinRatio: 1.1,
  mtfDailyFilterEnabled: true,
  correlationFilterEnabled: true,
  weekendFilterEnabled: true,
  dynamicRsiEnabled: true,
};

const good = {
  regime: { regime: 'bullish', confidence: 65, trade_allowed: true },
  price: 105,
  ema50_4h: 100,
  dailyEma50: 95,
  rsi1h: 55,
  volumeRatio: 1.2,
  correlationBlocked: false,
  weekendBlocked: false,
  hasOpen: false,
  openCount: 0,
  inCooldown: false,
  halted: false,
};

test('volume filter blocks weak volume, passes strong, skips when unavailable or disabled', () => {
  assert.equal(entryAllowed(good, cfg).ok, true);
  assert.equal(entryAllowed({ ...good, volumeRatio: 1.0 }, cfg).reason, 'low_volume');
  assert.equal(entryAllowed({ ...good, volumeRatio: null }, cfg).ok, true); // lenient on missing data
  assert.equal(entryAllowed({ ...good, volumeRatio: 1.0 }, { ...cfg, volumeFilterEnabled: false }).ok, true);
});

test('daily EMA(50) trend filter', () => {
  assert.equal(entryAllowed({ ...good, dailyEma50: 110 }, cfg).reason, 'below_daily_ema50');
  assert.equal(entryAllowed({ ...good, dailyEma50: null }, cfg).ok, true); // insufficient history
  assert.equal(entryAllowed({ ...good, dailyEma50: 110 }, { ...cfg, mtfDailyFilterEnabled: false }).ok, true);
});

test('correlation filter blocks correlated candidates', () => {
  assert.equal(entryAllowed({ ...good, correlationBlocked: true }, cfg).reason, 'correlation_blocked');
  assert.equal(entryAllowed({ ...good, correlationBlocked: true }, { ...cfg, correlationFilterEnabled: false }).ok, true);
});

test('weekend filter is opt-in and respects the Fri 20:00 -> Sun 20:00 UTC window', () => {
  assert.equal(entryAllowed({ ...good, weekendBlocked: true }, cfg).reason, 'weekend_filter');
  assert.equal(entryAllowed({ ...good, weekendBlocked: true }, { ...cfg, weekendFilterEnabled: false }).ok, true);
  // 2026-06-12 is a Friday
  assert.equal(isWeekendBlocked(new Date(Date.UTC(2026, 5, 12, 19, 59))), false);
  assert.equal(isWeekendBlocked(new Date(Date.UTC(2026, 5, 12, 20, 0))), true);
  assert.equal(isWeekendBlocked(new Date(Date.UTC(2026, 5, 13, 12, 0))), true); // Saturday
  assert.equal(isWeekendBlocked(new Date(Date.UTC(2026, 5, 14, 19, 59))), true); // Sunday
  assert.equal(isWeekendBlocked(new Date(Date.UTC(2026, 5, 14, 20, 0))), false);
  assert.equal(isWeekendBlocked(new Date(Date.UTC(2026, 5, 10, 12, 0))), false); // Wednesday
});

test('extreme euphoria tightens RSI ceiling and confidence floor', () => {
  const euphoric = { sentiment: 'very_bullish', intensity: 95 };
  const strong = { regime: 'bullish', confidence: 80, trade_allowed: true };
  // passes the stricter gate: rsi 55 <= 60, confidence 80 >= 75
  const pass = entryAllowed({ ...good, sentiment: euphoric, regime: strong }, cfg);
  assert.equal(pass.ok, true);
  assert.equal(pass.sentimentCaution, true);
  // rsi above the tightened 60 ceiling
  assert.equal(entryAllowed({ ...good, sentiment: euphoric, regime: strong, rsi1h: 65 }, cfg).reason, 'sentiment_caution_rsi');
  // confidence below the raised 75 floor
  assert.equal(entryAllowed({ ...good, sentiment: euphoric }, cfg).reason, 'sentiment_caution_confidence');
  // intensity at 85 is not "extreme" — normal rules apply
  const calm = entryAllowed({ ...good, sentiment: { sentiment: 'very_bullish', intensity: 85 }, rsi1h: 65 }, cfg);
  assert.equal(calm.ok, true);
  assert.equal(calm.sentimentCaution, false);
});

test('dynamic RSI zones follow the ATR percentile', () => {
  const ascending = Array.from({ length: 100 }, (_, i) => i + 1); // current is the max -> high vol
  assert.deepEqual(dynamicRsiBounds(ascending, cfg), { min: 42, max: 75 });
  const descending = Array.from({ length: 100 }, (_, i) => 100 - i); // current is the min -> low vol
  assert.deepEqual(dynamicRsiBounds(descending, cfg), { min: 48, max: 65 });
  const median = [...Array.from({ length: 99 }, (_, i) => i + 1), 50]; // current at the median
  assert.deepEqual(dynamicRsiBounds(median, cfg), { min: 45, max: 70 });
  assert.deepEqual(dynamicRsiBounds(ascending, { ...cfg, dynamicRsiEnabled: false }), { min: 45, max: 70 });
  assert.deepEqual(dynamicRsiBounds([1, 2, 3], cfg), { min: 45, max: 70 }); // window too short
});

test('regime-dependent risk sizing scales risk and notional cap on high confidence', () => {
  const riskCfg = {
    riskPerTrade: 0.01, stopAtrMult: 1.5, maxNotionalPct: 0.25,
    regimeRiskScalingEnabled: true, riskPctHighConf: 0.015, maxNotionalHighConf: 0.3, highConfThreshold: 80,
  };
  // base: $10 risk / 6 stop distance
  const base = computePositionSize(1000, 50, 4, riskCfg, { regime: 'bullish', confidence: 70 });
  assert.ok(Math.abs(base.qty - 10 / 6) < 1e-9);
  assert.equal(base.riskPct, 0.01);
  // high confidence: $15 risk / 6
  const high = computePositionSize(1000, 50, 4, riskCfg, { regime: 'bullish', confidence: 85 });
  assert.ok(Math.abs(high.qty - 15 / 6) < 1e-9);
  assert.equal(high.riskPct, 0.015);
  // bearish high confidence never scales
  const bear = computePositionSize(1000, 50, 4, riskCfg, { regime: 'bearish', confidence: 95 });
  assert.equal(bear.riskPct, 0.01);
  // high-conf notional cap is 30%: price 60000, ATR 100 -> qty capped at 300/60000
  const capped = computePositionSize(1000, 60000, 100, riskCfg, { regime: 'bullish', confidence: 90 });
  assert.ok(Math.abs(capped.qty - 300 / 60000) < 1e-12);
});

test('volatility targeting scales down hot portfolios and never scales up', () => {
  const volCfg = { volTargetingEnabled: true, volTargetAnnualized: 0.4 };
  const flat = Array(30).fill(1000);
  assert.equal(volTargetScale(flat, volCfg), 1);
  // alternating +/-5% hourly equity moves: far above 40% annualized
  const wild = [];
  let eq = 1000;
  for (let i = 0; i < 30; i++) {
    eq = i % 2 ? eq * 1.05 : eq * 0.95;
    wild.push(eq);
  }
  const scale = volTargetScale(wild, volCfg);
  assert.ok(scale > 0 && scale < 0.2, `expected heavy scaling, got ${scale}`);
  assert.equal(volTargetScale([1000, 1001], volCfg), 1); // not enough history
  assert.equal(volTargetScale(wild, { ...volCfg, volTargetingEnabled: false }), 1);
});
