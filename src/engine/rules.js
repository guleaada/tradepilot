// Deterministic strategy + risk rules. This module is the ONLY component that
// opens or closes positions. No AI in here — the regime object is a plain
// input, and everything dangerous (sizing, stops, halts) is hard-coded logic.
import { config } from '../config.js';
import { getDb, logEvent } from '../db.js';
import {
  closeTrade,
  ensureDayOpenEquity,
  getCash,
  getEquity,
  getOpenPosition,
  getOpenPositions,
  openTrade,
} from './portfolio.js';

// --- pure functions (unit-tested) ---

// Risk 1% of equity per trade; size derived from ATR stop distance; notional
// capped at maxNotionalPct of equity.
export function computePositionSize(equity, price, atrValue, cfg = config) {
  const stopDist = cfg.stopAtrMult * atrValue;
  if (!(stopDist > 0) || !(price > 0) || !(equity > 0)) {
    return { qty: 0, stopDist: 0, notional: 0, capped: false };
  }
  const riskAmount = equity * cfg.riskPerTrade;
  let qty = riskAmount / stopDist;
  let capped = false;
  const maxNotional = equity * cfg.maxNotionalPct;
  if (qty * price > maxNotional) {
    qty = maxNotional / price;
    capped = true;
  }
  return { qty, stopDist, notional: qty * price, capped };
}

// Exit checks for an open long: stop, take-profit, or strong bearish flip.
export function evaluateExit(position, price, regime, cfg = config) {
  if (price <= position.stop_price) return 'stop';
  if (price >= position.tp_price) return 'tp';
  if (regime && regime.regime === 'bearish' && regime.confidence >= cfg.regimeFlipConfidence) {
    return 'regime_flip';
  }
  return null;
}

// All entry conditions in one place. Returns { ok, reason }.
export function entryAllowed({ regime, price, ema50_4h, rsi1h, hasOpen, openCount, inCooldown, halted }, cfg = config) {
  if (halted) return { ok: false, reason: 'risk_halt' };
  if (hasOpen) return { ok: false, reason: 'position_open' };
  if (openCount >= cfg.maxPositions) return { ok: false, reason: 'max_positions' };
  if (inCooldown) return { ok: false, reason: 'cooldown' };
  if (!regime || regime.regime !== 'bullish') return { ok: false, reason: 'regime_not_bullish' };
  if (!regime.trade_allowed) return { ok: false, reason: 'trade_not_allowed' };
  if (regime.confidence < cfg.regimeMinConfidence) return { ok: false, reason: 'low_confidence' };
  if (ema50_4h === null || !(price > ema50_4h)) return { ok: false, reason: 'below_ema50_4h' };
  if (rsi1h === null || rsi1h < cfg.rsiEntryMin || rsi1h > cfg.rsiEntryMax) {
    return { ok: false, reason: 'rsi_out_of_band' };
  }
  return { ok: true, reason: 'entry' };
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

// Daily drawdown halt: if equity is down dailyDrawdownHalt vs the day's open,
// block all NEW entries until the next UTC day. Exits still run.
export function isHalted(equity, db = getDb(), cfg = config) {
  const dayOpen = ensureDayOpenEquity(equity, db);
  const halted = equity <= dayOpen * (1 - cfg.dailyDrawdownHalt);
  if (halted) {
    const today = new Date().toISOString().slice(0, 10);
    const already = db
      .prepare("SELECT id FROM events WHERE type = 'RISK_HALT' AND ts >= ? LIMIT 1")
      .get(`${today}T00:00:00`);
    if (!already) logEvent('RISK_HALT', { equity, dayOpen, drawdownPct: (1 - equity / dayOpen) * 100 }, db);
  }
  return halted;
}

// Run exits then (maybe) one entry for a pair. Returns a list of actions taken.
// Executor calls are awaited so the same code path serves PaperExecutor
// (synchronous values) and TestnetExecutor (real network fills). An executor
// may return { skipped: <reason> } instead of a fill; that never throws.
export async function runPairRules({ pair, price, atr1h, rsi1h, ema50_4h, regime, executor, db = getDb(), cfg = config, prices = {}, entriesBlocked = false }) {
  const actions = [];

  // 1. Exits — checked every cycle against live price.
  const position = getOpenPosition(pair, db);
  if (position) {
    const reason = evaluateExit(position, price, regime, cfg);
    if (reason) {
      const fill = await executor.sell(pair, position.qty, price);
      if (fill.skipped) {
        // Position stays open; we retry next cycle. State remains consistent.
        logEvent('EXIT_ORDER_SKIPPED', { pair, reason: fill.skipped, wanted: reason }, db);
        actions.push({ type: 'exit_skipped', pair, reason: fill.skipped });
      } else {
        const pnl = closeTrade(
          position.id,
          { fillPrice: fill.fillPrice, fee: fill.fee, reason, orderId: fill.orderId ?? null },
          db,
        );
        logEvent('TRADE_CLOSED', { pair, reason, pnl, exitPrice: fill.fillPrice, signal: price }, db);
        actions.push({ type: 'close', pair, reason, pnl, exit: fill.fillPrice, signal: price });
      }
    }
  }

  // 2. Entry gate.
  const equity = getEquity({ ...prices, [pair]: price }, db);
  const halted = isHalted(equity, db, cfg) || entriesBlocked;
  const gate = entryAllowed(
    {
      regime,
      price,
      ema50_4h,
      rsi1h,
      hasOpen: !!getOpenPosition(pair, db),
      openCount: getOpenPositions(db).length,
      inCooldown: isInCooldown(pair, db, cfg),
      halted,
    },
    cfg,
  );
  if (!gate.ok) {
    actions.push({ type: 'no_entry', pair, reason: gate.reason });
    return actions;
  }

  // 3. Sizing, cash pre-check (BEFORE any order leaves), then the fill.
  const { qty, stopDist } = computePositionSize(equity, price, atr1h, cfg);
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
  const stopPrice = fill.fillPrice - stopDist;
  const tpPrice = fill.fillPrice + cfg.tpAtrMult * atr1h;
  const tradeId = openTrade(
    { pair, qty: tradeQty, fillPrice: fill.fillPrice, fee: fill.fee, stopPrice, tpPrice, orderId: fill.orderId ?? null },
    db,
  );
  logEvent('TRADE_OPENED', { pair, tradeId, qty: tradeQty, entry: fill.fillPrice, signal: price, stop: stopPrice, tp: tpPrice }, db);
  actions.push({ type: 'open', pair, tradeId, qty: tradeQty, entry: fill.fillPrice, signal: price, stop: stopPrice, tp: tpPrice });
  return actions;
}
