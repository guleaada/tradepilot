// Virtual portfolio: cash, open positions, equity, P&L. All state in SQLite.
// `at` timestamps default to wall-clock but are overridable so the backtester
// can stamp rows with candle time.
import { getDb, nowIso } from '../db.js';
import { returns, stdev } from '../indicators.js';
import { config } from '../config.js';

export function getCash(db = getDb()) {
  return db.prepare('SELECT cash FROM portfolio WHERE id = 1').get().cash;
}

export function setCash(cash, db = getDb()) {
  db.prepare('UPDATE portfolio SET cash = ? WHERE id = 1').run(cash);
}

export function getOpenPositions(db = getDb()) {
  return db.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY id").all();
}

export function getOpenPosition(pair, db = getDb()) {
  return db.prepare("SELECT * FROM trades WHERE status = 'open' AND pair = ?").get(pair);
}

// Equity = cash + mark-to-market value of open positions. Falls back to entry
// price when no live price is available for a pair.
export function getEquity(prices = {}, db = getDb()) {
  const cash = getCash(db);
  const open = getOpenPositions(db);
  return open.reduce((eq, p) => eq + p.qty * (prices[p.pair] ?? p.entry_price), cash);
}

export function openTrade(
  { pair, qty, fillPrice, fee, stopPrice, tpPrice, orderId = null, regimeAtEntry = null, confidenceAtEntry = null, at = nowIso() },
  db = getDb(),
) {
  const cost = fillPrice * qty + fee;
  const cash = getCash(db);
  if (cost > cash + 1e-9) throw new Error(`insufficient cash: need ${cost}, have ${cash}`);
  const tx = db.transaction(() => {
    setCash(cash - cost, db);
    const info = db
      .prepare(
        `INSERT INTO trades
           (pair, side, status, entry_time, entry_price, qty, stop_price, tp_price, entry_fee,
            entry_order_id, initial_risk, regime_at_entry, confidence_at_entry)
         VALUES (?, 'long', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pair, at, fillPrice, qty, stopPrice, tpPrice, fee,
        orderId === null ? null : String(orderId),
        fillPrice - stopPrice, // initial R distance, fixed for the life of the trade
        regimeAtEntry, confidenceAtEntry,
      );
    return info.lastInsertRowid;
  });
  return tx();
}

// Sell part of an open position. Realized partial P&L accumulates in
// partial_pnl; entry_fee is scaled down proportionally so the final close's
// remainder math stays consistent.
export function partialCloseTrade(tradeId, { sellQty, fillPrice, fee }, db = getDb()) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade || trade.status !== 'open') throw new Error(`trade ${tradeId} not open`);
  if (!(sellQty > 0) || sellQty >= trade.qty) throw new Error(`invalid partial qty ${sellQty} of ${trade.qty}`);
  const proceeds = fillPrice * sellQty - fee;
  const costShare = trade.entry_price * sellQty + trade.entry_fee * (sellQty / trade.qty);
  const partialPnl = proceeds - costShare;
  const remainder = trade.qty - sellQty;
  const remainderFee = trade.entry_fee * (remainder / trade.qty);
  const tx = db.transaction(() => {
    setCash(getCash(db) + proceeds, db);
    db.prepare(
      `UPDATE trades
       SET qty = ?, remainder_qty = ?, entry_fee = ?, partial_exit_done = 1,
           partial_pnl = COALESCE(partial_pnl, 0) + ?
       WHERE id = ?`,
    ).run(remainder, remainder, remainderFee, partialPnl, tradeId);
  });
  tx();
  return partialPnl;
}

export function closeTrade(tradeId, { fillPrice, fee, reason, orderId = null, at = nowIso() }, db = getDb()) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade || trade.status !== 'open') throw new Error(`trade ${tradeId} not open`);
  const proceeds = fillPrice * trade.qty - fee;
  // Total trade P&L = remainder leg + any realized partial-exit P&L.
  const pnl = proceeds - (trade.entry_price * trade.qty + trade.entry_fee) + (trade.partial_pnl || 0);
  const tx = db.transaction(() => {
    setCash(getCash(db) + proceeds, db);
    db.prepare(
      `UPDATE trades
       SET status = 'closed', exit_time = ?, exit_price = ?, exit_fee = ?, pnl = ?, exit_reason = ?, exit_order_id = ?
       WHERE id = ?`,
    ).run(at, fillPrice, fee, pnl, reason, orderId === null ? null : String(orderId), tradeId);

    // Regime accuracy: how did the regime that was active at entry pay off?
    if (trade.regime_at_entry) {
      const originalQty = trade.remainder_qty !== null && trade.remainder_qty !== undefined && trade.partial_exit_done
        ? trade.qty / (1 - config.partialExitFraction)
        : trade.qty;
      const entryNotional = trade.entry_price * originalQty;
      const durationMin = (Date.parse(at) - Date.parse(trade.entry_time)) / 60_000;
      db.prepare(
        `INSERT INTO regime_accuracy (ts, pair, regime_at_entry, confidence_at_entry, actual_return_pct, duration_minutes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(at, trade.pair, trade.regime_at_entry, trade.confidence_at_entry,
        entryNotional > 0 ? (pnl / entryNotional) * 100 : null,
        Number.isFinite(durationMin) ? durationMin : null);
    }
  });
  tx();
  return pnl;
}

// Records the first equity reading of each UTC day; used by the drawdown halt.
export function ensureDayOpenEquity(equity, db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  db.prepare('INSERT OR IGNORE INTO daily_equity (date, open_equity) VALUES (?, ?)').run(date, equity);
  return db.prepare('SELECT open_equity FROM daily_equity WHERE date = ?').get(date).open_equity;
}

// Hourly equity snapshots (skips if the last snapshot is < 1h old).
export function snapshotEquity(equity, cash, db = getDb(), ts = nowIso()) {
  const last = db.prepare('SELECT ts FROM equity_snapshots ORDER BY id DESC LIMIT 1').get();
  if (last && Date.parse(ts) - Date.parse(last.ts) < 3_600_000) return false;
  db.prepare('INSERT INTO equity_snapshots (ts, equity, cash) VALUES (?, ?, ?)').run(ts, equity, cash);
  return true;
}

export function todayPnl(db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  const row = db
    .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE status = 'closed' AND exit_time >= ?")
    .get(`${date}T00:00:00`);
  return row.pnl;
}

// --- portfolio risk metrics ---

// Volatility-targeting scale factor from an equity series (pure).
// Realized vol = stdev of hourly equity returns, annualized by sqrt(8760).
// Never scales up: result is in (0, 1].
export function volTargetScale(equitySeries, cfg = config) {
  if (!cfg.volTargetingEnabled) return 1;
  if (!equitySeries || equitySeries.length < 21) return 1;
  const rets = returns(equitySeries.slice(-21));
  const sd = stdev(rets);
  if (sd === null || !(sd > 0)) return 1;
  const annualized = sd * Math.sqrt(24 * 365);
  if (annualized <= cfg.volTargetAnnualized) return 1;
  return cfg.volTargetAnnualized / annualized;
}

export function volTargetScaleFromDb(db = getDb(), cfg = config) {
  const rows = db.prepare('SELECT equity FROM equity_snapshots ORDER BY id DESC LIMIT 21').all();
  return volTargetScale(rows.map((r) => r.equity).reverse(), cfg);
}

// Drawdown from peak equity, as a fraction (0 = at the peak).
export function drawdownFromPeak(db = getDb()) {
  const rows = db.prepare('SELECT equity FROM equity_snapshots ORDER BY id').all();
  if (!rows.length) return 0;
  const peak = Math.max(...rows.map((r) => r.equity));
  const current = rows[rows.length - 1].equity;
  return peak > 0 ? Math.max(0, (peak - current) / peak) : 0;
}

// Trailing 7-day win rate and profit factor from closed trades.
export function trailing7dStats(db = getDb(), now = Date.now()) {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const closed = db
    .prepare("SELECT pnl FROM trades WHERE status = 'closed' AND exit_time >= ?")
    .all(since);
  if (!closed.length) return { trades: 0, winRate: null, profitFactor: null };
  const wins = closed.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    trades: closed.length,
    winRate: wins.length / closed.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
  };
}
