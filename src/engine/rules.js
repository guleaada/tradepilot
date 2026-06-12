// Deterministic strategy + risk rules. This module is the ONLY component that
// opens or closes positions. No AI in here — the regime/sentiment objects are
// plain inputs, and everything dangerous (sizing, stops, halts) is hard-coded
// logic. Every new filter is gated by a config flag; with the flag off the
// behavior is identical to the original rule set.
import { config } from '../config.js';
import { getDb, logEvent } from '../db.js';
import { percentileRank } from '../indicators.js';
import {
  closeTrade,
  ensureDayOpenEquity,
  getCash,
  getEquity,
  getOpenPosition,
  getOpenPositions,
  openTrade,
  partialCloseTrade,
} from './portfolio.js';

// --- pure functions (unit-tested) ---

// Risk per trade is 1% of equity (1.5% when the regime is bullish with
// confidence >= highConfThreshold and scaling is enabled). Size derives from
// the ATR stop distance; notional capped at 25% (30% high-confidence).
export function computePositionSize(equity, price, atrValue, cfg = config, regime = null) {
  const stopDist = cfg.stopAtrMult * atrValue;
  if (!(stopDist > 0) || !(price > 0) || !(equity > 0)) {
    return { qty: 0, stopDist: 0, notional: 0, capped: false, riskPct: cfg.riskPerTrade };
  }
  const highConf =
    cfg.regimeRiskScalingEnabled &&
    regime &&
    regime.regime === 'bullish' &&
    regime.confidence >= (cfg.highConfThreshold ?? 80);
  const riskPct = highConf ? cfg.riskPctHighConf : cfg.riskPerTrade;
  const notionalPct = highConf ? cfg.maxNotionalHighConf : cfg.maxNotionalPct;
  let qty = (equity * riskPct) / stopDist;
  let capped = false;
  const maxNotional = equity * notionalPct;
  if (qty * price > maxNotional) {
    qty = maxNotional / price;
    capped = true;
  }
  return { qty, stopDist, notional: qty * price, capped, riskPct };
}

// Exit checks for an open long: emergency price-action exit first, then stop,
// take-profit, or strong bearish flip.
export function evaluateExit(position, price, regime, cfg = config) {
  if (cfg.emergencyExitEnabled && price <= position.entry_price * (1 - cfg.emergencyExitDropPct)) {
    return 'emergency_exit';
  }
  if (price <= position.stop_price) return 'stop';
  if (price >= position.tp_price) return 'tp';
  if (regime && regime.regime === 'bearish' && regime.confidence >= cfg.regimeFlipConfidence) {
    return 'regime_flip';
  }
  return null;
}

// Dynamic RSI zones from the ATR percentile (rank of the current ATR within
// the trailing window, up to 14 days of hourly values).
export function dynamicRsiBounds(atrSeries, cfg = config) {
  const normal = { min: cfg.rsiEntryMin, max: cfg.rsiEntryMax };
  if (!cfg.dynamicRsiEnabled) return normal;
  const window = (atrSeries || []).filter((v) => Number.isFinite(v)).slice(-336); // 14d of 1h ATRs
  if (window.length < 20) return normal;
  const rank = percentileRank(window, window[window.length - 1]);
  if (rank === null) return normal;
  if (rank < 0.4) return { min: 48, max: 65 }; // calm tape: demand cleaner momentum
  if (rank > 0.6) return { min: 42, max: 75 }; // volatile tape: wider band
  return normal;
}

// Weekend / low-liquidity window: Friday 20:00 UTC through Sunday 20:00 UTC.
export function isWeekendBlocked(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const hour = date.getUTCHours();
  if (day === 5 && hour >= 20) return true;
  if (day === 6) return true;
  if (day === 0 && hour < 20) return true;
  return false;
}

// Trailing-stop / partial-exit state machine for an open long. Pure: returns
// the actions to apply, in order. R is the initial risk distance, fixed at
// entry (entry_price - initial stop).
export function trailingStopActions(position, price, cfg = config) {
  if (!cfg.trailingStopEnabled) return [];
  const entry = position.entry_price;
  const R = position.initial_risk ?? (position.trailing_stop_active ? null : entry - position.stop_price);
  if (!(R > 0)) return [];
  const actions = [];
  if (!position.trailing_stop_active && price >= entry + cfg.breakevenR * R) {
    actions.push({ action: 'breakeven', newStop: entry });
  }
  if (!position.partial_exit_done && price >= entry + cfg.partialExitR * R) {
    actions.push({
      action: 'partial_exit',
      sellQty: position.qty * cfg.partialExitFraction,
      newStop: entry,
      newTp: entry + cfg.extendedTpR * R,
    });
  }
  return actions;
}

// All entry conditions in one place. Returns { ok, reason, sentimentCaution }.
// New inputs (volumeRatio, dailyEma50, rsiMin/rsiMax, correlationBlocked,
// weekendBlocked, sentiment) are optional; when absent or when their config
// flag is off, the gate behaves exactly as the original version.
export function entryAllowed(input, cfg = config) {
  const {
    regime, sentiment, price, ema50_4h, dailyEma50, rsi1h,
    volumeRatio, correlationBlocked, weekendBlocked,
    hasOpen, openCount, inCooldown, halted,
  } = input;
  const rsiMin = input.rsiMin ?? cfg.rsiEntryMin;
  const rsiMax = input.rsiMax ?? cfg.rsiEntryMax;

  // Extreme crowd euphoria is a caution signal, not a buy signal: tighten the
  // RSI ceiling and demand more regime conviction.
  const sentimentCaution = !!(
    sentiment && sentiment.sentiment === 'very_bullish' && sentiment.intensity > 90
  );

  const fail = (reason) => ({ ok: false, reason, sentimentCaution });

  if (halted) return fail('risk_halt');
  if (hasOpen) return fail('position_open');
  if (openCount >= cfg.maxPositions) return fail('max_positions');
  if (inCooldown) return fail('cooldown');
  if (cfg.weekendFilterEnabled && weekendBlocked) return fail('weekend_filter');
  if (!regime || regime.regime !== 'bullish') return fail('regime_not_bullish');
  if (!regime.trade_allowed) return fail('trade_not_allowed');
  const minConfidence = sentimentCaution ? Math.max(cfg.regimeMinConfidence, 75) : cfg.regimeMinConfidence;
  if (regime.confidence < minConfidence) return fail(sentimentCaution ? 'sentiment_caution_confidence' : 'low_confidence');
  if (ema50_4h === null || ema50_4h === undefined || !(price > ema50_4h)) return fail('below_ema50_4h');
  if (cfg.mtfDailyFilterEnabled && dailyEma50 !== null && dailyEma50 !== undefined && !(price > dailyEma50)) {
    return fail('below_daily_ema50');
  }
  const effectiveRsiMax = sentimentCaution ? Math.min(rsiMax, 60) : rsiMax;
  if (rsi1h === null || rsi1h === undefined || rsi1h < rsiMin || rsi1h > effectiveRsiMax) {
    return fail(sentimentCaution && rsi1h > 60 ? 'sentiment_caution_rsi' : 'rsi_out_of_band');
  }
  if (cfg.volumeFilterEnabled && volumeRatio !== null && volumeRatio !== undefined && volumeRatio < cfg.volumeMinRatio) {
    return fail('low_volume');
  }
  if (cfg.correlationFilterEnabled && correlationBlocked) return fail('correlation_blocked');
  return { ok: true, reason: 'entry', sentimentCaution };
}

// --- DB-backed helpers ---

export function isInCooldown(pair, db = getDb(), cfg = config, now = Date.now()) {
  const lastStop = db
    .prepare(
      "SELECT exit_time FROM trades WHERE pair = ? AND status = 'closed' AND exit_reason = 'stop' ORDER BY id DESC LIMIT 1",
    )
    .get(pair);
  if (!lastStop) return false;
  return now - Date.parse(lastStop.exit_time) < cfg.cooldownHours * 3_600_000;
}

// Daily drawdown halt: if equity drops dailyDrawdownHalt vs the day's open,
// block all NEW entries until the next UTC day. Exits still run.
export function isHalted(equity, db = getDb(), cfg = config, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const date = nowIso.slice(0, 10);
  const dayOpen = ensureDayOpenEquity(equity, db, date);
  const halted = equity <= dayOpen * (1 - cfg.dailyDrawdownHalt);
  if (halted) {
    const already = db
      .prepare("SELECT id FROM events WHERE type = 'RISK_HALT' AND ts >= ? LIMIT 1")
      .get(`${date}T00:00:00`);
    if (!already) logEvent('RISK_HALT', { equity, dayOpen, drawdownPct: (1 - equity / dayOpen) * 100 }, db, nowIso);
  }
  return halted;
}

// Run position management (trailing/partial/exits) then (maybe) one entry for
// a pair. Returns a list of actions taken. Executor calls are awaited so the
// same code path serves PaperExecutor (sync values) and TestnetExecutor (real
// network fills). An executor may return { skipped: <reason> }; never throws.
export async function runPairRules({
  pair, price, atr1h, rsi1h, ema50_4h, dailyEma50 = null, regime, sentiment = null,
  volumeRatio = null, rsiBounds = null, correlationBlocked = false,
  executor, db = getDb(), cfg = config, prices = {}, entriesBlocked = false,
  volScale = 1, now = Date.now(),
}) {
  const actions = [];
  const atIso = new Date(now).toISOString();

  // 1. Trailing stop + partial exit state machine.
  let position = getOpenPosition(pair, db);
  if (position) {
    for (const act of trailingStopActions(position, price, cfg)) {
      if (act.action === 'breakeven') {
        db.prepare('UPDATE trades SET stop_price = ?, trailing_stop_active = 1 WHERE id = ?').run(act.newStop, position.id);
        logEvent('TRAILING_STOP_ACTIVATED', { pair, tradeId: position.id, newStop: act.newStop }, db, atIso);
        actions.push({ type: 'breakeven', pair, newStop: act.newStop });
      } else if (act.action === 'partial_exit') {
        const fill = await executor.sell(pair, act.sellQty, price);
        if (fill.skipped) {
          logEvent('PARTIAL_EXIT_SKIPPED', { pair, reason: fill.skipped }, db, atIso);
        } else {
          const soldQty = Math.min(fill.executedQty ?? act.sellQty, position.qty * 0.999999);
          const partialPnl = partialCloseTrade(position.id, { sellQty: soldQty, fillPrice: fill.fillPrice, fee: fill.fee }, db);
          db.prepare('UPDATE trades SET stop_price = ?, tp_price = ?, trailing_stop_active = 1 WHERE id = ?')
            .run(act.newStop, act.newTp, position.id);
          logEvent('PARTIAL_EXIT', { pair, tradeId: position.id, soldQty, partialPnl, newTp: act.newTp }, db, atIso);
          actions.push({ type: 'partial_exit', pair, soldQty, partialPnl, newTp: act.newTp });
        }
      }
    }
    position = getOpenPosition(pair, db); // refresh after state changes
  }

  // 2. Exits — checked every cycle against live price.
  if (position) {
    const reason = evaluateExit(position, price, regime, cfg);
    if (reason) {
      const fill = await executor.sell(pair, position.qty, price);
      if (fill.skipped) {
        // Position stays open; we retry next cycle. State remains consistent.
        logEvent('EXIT_ORDER_SKIPPED', { pair, reason: fill.skipped, wanted: reason }, db, atIso);
        actions.push({ type: 'exit_skipped', pair, reason: fill.skipped });
      } else {
        const pnl = closeTrade(
          position.id,
          { fillPrice: fill.fillPrice, fee: fill.fee, reason, orderId: fill.orderId ?? null, at: atIso },
          db,
        );
        logEvent('TRADE_CLOSED', { pair, reason, pnl, exitPrice: fill.fillPrice, signal: price }, db, atIso);
        actions.push({ type: 'close', pair, reason, pnl, exit: fill.fillPrice, signal: price });
      }
    }
  }

  // 3. Entry gate.
  const equity = getEquity({ ...prices, [pair]: price }, db);
  const halted = isHalted(equity, db, cfg, now) || entriesBlocked;
  const bounds = rsiBounds ?? { min: cfg.rsiEntryMin, max: cfg.rsiEntryMax };
  const gate = entryAllowed(
    {
      regime,
      sentiment,
      price,
      ema50_4h,
      dailyEma50,
      rsi1h,
      rsiMin: bounds.min,
      rsiMax: bounds.max,
      volumeRatio,
      correlationBlocked,
      weekendBlocked: isWeekendBlocked(new Date(now)),
      hasOpen: !!getOpenPosition(pair, db),
      openCount: getOpenPositions(db).length,
      inCooldown: isInCooldown(pair, db, cfg, now),
      halted,
    },
    cfg,
  );
  if (gate.sentimentCaution) {
    logEvent('SENTIMENT_CAUTION', { pair, intensity: sentiment?.intensity, outcome: gate.reason }, db, atIso);
  }
  if (!gate.ok) {
    actions.push({ type: 'no_entry', pair, reason: gate.reason });
    return actions;
  }

  // 4. Sizing (regime-aware, volatility-targeted), cash pre-check, fill.
  const sized = computePositionSize(equity, price, atr1h, cfg, regime);
  const qty = sized.qty * Math.min(1, volScale);
  if (qty <= 0) {
    actions.push({ type: 'no_entry', pair, reason: 'zero_size' });
    return actions;
  }
  const estCost = qty * price * (1 + cfg.slippage) * (1 + cfg.takerFee);
  if (estCost > getCash(db)) {
    actions.push({ type: 'no_entry', pair, reason: 'insufficient_cash' });
    return actions;
  }
  const fill = await executor.buy(pair, qty, price);
  if (fill.skipped) {
    actions.push({ type: 'no_entry', pair, reason: fill.skipped });
    return actions;
  }
  const tradeQty = fill.executedQty ?? qty;
  const stopPrice = fill.fillPrice - sized.stopDist;
  const tpPrice = fill.fillPrice + cfg.tpAtrMult * atr1h;
  const tradeId = openTrade(
    {
      pair, qty: tradeQty, fillPrice: fill.fillPrice, fee: fill.fee, stopPrice, tpPrice,
      orderId: fill.orderId ?? null,
      regimeAtEntry: regime?.regime ?? null,
      confidenceAtEntry: regime?.confidence ?? null,
      at: atIso,
    },
    db,
  );
  logEvent('TRADE_OPENED', { pair, tradeId, qty: tradeQty, entry: fill.fillPrice, signal: price, stop: stopPrice, tp: tpPrice, riskPct: sized.riskPct, volScale }, db, atIso);
  actions.push({ type: 'open', pair, tradeId, qty: tradeQty, entry: fill.fillPrice, signal: price, stop: stopPrice, tp: tpPrice });
  return actions;
}
