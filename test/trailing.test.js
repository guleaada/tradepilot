import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { trailingStopActions } from '../src/engine/rules.js';
import { closeTrade, getCash, openTrade, partialCloseTrade } from '../src/engine/portfolio.js';

const cfg = {
  trailingStopEnabled: true,
  breakevenR: 1.5,
  partialExitR: 2.0,
  partialExitFraction: 0.5,
  extendedTpR: 4.0,
};

// entry 100, initial stop 94 -> R = 6. Breakeven at 109, partial at 112.
const fresh = {
  entry_price: 100,
  stop_price: 94,
  qty: 10,
  initial_risk: 6,
  trailing_stop_active: 0,
  partial_exit_done: 0,
};

test('trailing stop state machine transitions in order', () => {
  assert.deepEqual(trailingStopActions(fresh, 105, cfg), []); // below 1.5R

  const be = trailingStopActions(fresh, 109, cfg); // exactly 1.5R
  assert.equal(be.length, 1);
  assert.deepEqual(be[0], { action: 'breakeven', newStop: 100 });

  const both = trailingStopActions(fresh, 112, cfg); // 2.0R: breakeven + partial in one move
  assert.deepEqual(both.map((a) => a.action), ['breakeven', 'partial_exit']);
  assert.equal(both[1].sellQty, 5); // 50% of 10
  assert.equal(both[1].newTp, 124); // entry + 4.0R = 100 + 24

  // already at breakeven: only the partial remains
  const armed = { ...fresh, trailing_stop_active: 1, stop_price: 100 };
  assert.deepEqual(trailingStopActions(armed, 112, cfg).map((a) => a.action), ['partial_exit']);

  // fully processed: nothing more to do
  const done = { ...armed, partial_exit_done: 1, qty: 5 };
  assert.deepEqual(trailingStopActions(done, 130, cfg), []);

  assert.deepEqual(trailingStopActions(fresh, 130, { ...cfg, trailingStopEnabled: false }), []);
});

test('legacy rows without initial_risk derive R from entry - stop (pre-breakeven only)', () => {
  const legacy = { ...fresh, initial_risk: null };
  assert.deepEqual(trailingStopActions(legacy, 109, cfg)[0], { action: 'breakeven', newStop: 100 });
  // once the stop has moved, R is unrecoverable without initial_risk -> no action
  const moved = { ...legacy, trailing_stop_active: 1, stop_price: 100 };
  assert.deepEqual(trailingStopActions(moved, 130, cfg), []);
});

test('partial exit math: cash, remainder, fee scaling, and total P&L stay consistent', () => {
  const db = openDb(':memory:');
  // buy 2 @ 100 with $0.20 entry fee -> cash 1000 - 200.2 = 799.8
  const id = openTrade({ pair: 'BTCUSDT', qty: 2, fillPrice: 100, fee: 0.2, stopPrice: 94, tpPrice: 115 }, db);
  assert.ok(Math.abs(getCash(db) - 799.8) < 1e-9);
  let row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  assert.equal(row.initial_risk, 6); // stored R distance

  // sell 1 @ 112 with $0.112 fee:
  // proceeds = 112 - 0.112 = 111.888
  // cost share = 100*1 + 0.2*(1/2) = 100.1 -> partial pnl = 11.788
  const partialPnl = partialCloseTrade(id, { sellQty: 1, fillPrice: 112, fee: 0.112 }, db);
  assert.ok(Math.abs(partialPnl - 11.788) < 1e-9);
  row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  assert.equal(row.qty, 1);
  assert.equal(row.remainder_qty, 1);
  assert.equal(row.partial_exit_done, 1);
  assert.ok(Math.abs(row.entry_fee - 0.1) < 1e-9); // scaled to the remainder
  assert.ok(Math.abs(row.partial_pnl - 11.788) < 1e-9);
  assert.ok(Math.abs(getCash(db) - (799.8 + 111.888)) < 1e-9);

  // close remainder @ 124 with $0.124 fee:
  // remainder pnl = (124 - 0.124) - (100 + 0.1) = 23.776; total = + partial = 35.564
  const pnl = closeTrade(id, { fillPrice: 124, fee: 0.124, reason: 'tp' }, db);
  assert.ok(Math.abs(pnl - 35.564) < 1e-9);
  // invariant: cash = starting balance + total trade P&L
  assert.ok(Math.abs(getCash(db) - (1000 + 35.564)) < 1e-9);
  db.close();
});

test('closing a trade with regime data records a regime_accuracy row', () => {
  const db = openDb(':memory:');
  const id = openTrade(
    { pair: 'ETHUSDT', qty: 1, fillPrice: 100, fee: 0.1, stopPrice: 94, tpPrice: 115, regimeAtEntry: 'bullish', confidenceAtEntry: 72 },
    db,
  );
  closeTrade(id, { fillPrice: 110, fee: 0.11, reason: 'tp' }, db);
  const row = db.prepare('SELECT * FROM regime_accuracy').get();
  assert.equal(row.pair, 'ETHUSDT');
  assert.equal(row.regime_at_entry, 'bullish');
  assert.equal(row.confidence_at_entry, 72);
  assert.ok(row.actual_return_pct > 0);
  db.close();
});
