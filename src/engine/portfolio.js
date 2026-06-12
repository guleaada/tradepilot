// Virtual portfolio: cash, open positions, equity, P&L. All state in SQLite.
import { getDb, nowIso } from '../db.js';

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

export function openTrade({ pair, qty, fillPrice, fee, stopPrice, tpPrice }, db = getDb()) {
  const cost = fillPrice * qty + fee;
  const cash = getCash(db);
  if (cost > cash + 1e-9) throw new Error(`insufficient cash: need ${cost}, have ${cash}`);
  const tx = db.transaction(() => {
    setCash(cash - cost, db);
    const info = db
      .prepare(
        `INSERT INTO trades (pair, side, status, entry_time, entry_price, qty, stop_price, tp_price, entry_fee)
         VALUES (?, 'long', 'open', ?, ?, ?, ?, ?, ?)`,
      )
      .run(pair, nowIso(), fillPrice, qty, stopPrice, tpPrice, fee);
    return info.lastInsertRowid;
  });
  return tx();
}

export function closeTrade(tradeId, { fillPrice, fee, reason }, db = getDb()) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade || trade.status !== 'open') throw new Error(`trade ${tradeId} not open`);
  const proceeds = fillPrice * trade.qty - fee;
  const pnl = proceeds - (trade.entry_price * trade.qty + trade.entry_fee);
  const tx = db.transaction(() => {
    setCash(getCash(db) + proceeds, db);
    db.prepare(
      `UPDATE trades
       SET status = 'closed', exit_time = ?, exit_price = ?, exit_fee = ?, pnl = ?, exit_reason = ?
       WHERE id = ?`,
    ).run(nowIso(), fillPrice, fee, pnl, reason, tradeId);
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
export function snapshotEquity(equity, cash, db = getDb()) {
  const last = db.prepare('SELECT ts FROM equity_snapshots ORDER BY id DESC LIMIT 1').get();
  if (last && Date.now() - Date.parse(last.ts) < 3_600_000) return false;
  db.prepare('INSERT INTO equity_snapshots (ts, equity, cash) VALUES (?, ?, ?)').run(nowIso(), equity, cash);
  return true;
}

export function todayPnl(db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  const row = db
    .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE status = 'closed' AND exit_time >= ?")
    .get(`${date}T00:00:00`);
  return row.pnl;
}
