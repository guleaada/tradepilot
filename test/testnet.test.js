import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  assertTestnetBase,
  createMockTestnetFetch,
  roundToStep,
  sign,
  TESTNET_BASE,
  TestnetExecutor,
} from '../src/engine/testnetExecutor.js';

function makeExecutor(overrides = {}) {
  const db = openDb(':memory:');
  const fetchImpl = overrides.fetchImpl ?? createMockTestnetFetch(overrides.mockOpts);
  const ex = new TestnetExecutor({ apiKey: 'test-key', apiSecret: 'test-secret', fetchImpl, db });
  return { ex, db, fetchImpl };
}

test('HMAC-SHA256 signing matches the Binance docs test vector', () => {
  // Official example from the Binance signed-endpoint documentation.
  const qs = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  assert.equal(sign(qs, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('quantity rounding floors to stepSize and never rounds up', () => {
  assert.equal(roundToStep(0.123456, '0.0001'), 0.1234);
  assert.equal(roundToStep(0.00012345, '0.00001000'), 0.00012);
  assert.equal(roundToStep(1.999999, '0.00001000'), 1.99999);
  assert.equal(roundToStep(5, '1.00000000'), 5);
  assert.equal(roundToStep(5.999, '1.00000000'), 5);
  // exact multiples survive float division
  assert.equal(roundToStep(0.0042, '0.0001'), 0.0042);
});

test('mainnet guard: refuses any non-testnet base URL', () => {
  assert.ok(TESTNET_BASE.includes('testnet'));
  assert.equal(assertTestnetBase(TESTNET_BASE), TESTNET_BASE);
  assert.throws(() => assertTestnetBase('https://api.binance.com'), /refuses non-testnet/);
  assert.throws(() => assertTestnetBase('https://api1.binance.com'), /refuses non-testnet/);
  assert.throws(() => assertTestnetBase(''), /refuses non-testnet/);
});

test('constructor requires testnet API keys', () => {
  assert.throws(
    () => new TestnetExecutor({ apiKey: '', apiSecret: '', fetchImpl: createMockTestnetFetch() }),
    /BINANCE_TESTNET_API_KEY/,
  );
});

test('below-min-notional order is skipped, never rounded up', async () => {
  const { ex, db } = makeExecutor();
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  // 0.00002 BTC * 66900 ≈ $1.34 < $5 min notional
  const fill = await ex.buy('BTCUSDT', 0.00002, 66900);
  assert.equal(fill.skipped, 'below_min_notional');
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'ORDER_BELOW_MIN_NOTIONAL'").get());
  // no order was sent to the exchange
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  db.close();
});

test('market buy records real fill data and audit row', async () => {
  const { ex, db } = makeExecutor();
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const fill = await ex.buy('BTCUSDT', 0.0037429, 66842);
  assert.equal(fill.skipped, undefined);
  assert.equal(fill.executedQty, 0.00374); // floored to 0.00001 step
  assert.equal(fill.fillPrice, 66900); // mock book price, not the signal
  assert.ok(fill.orderId >= 1000);
  assert.ok(Math.abs(fill.fee - 0.00374 * 0.001 * 66900) < 1e-9); // base-asset commission converted to quote

  const row = db.prepare('SELECT * FROM orders').get();
  assert.equal(row.pair, 'BTCUSDT');
  assert.equal(row.side, 'BUY');
  assert.equal(row.status, 'FILLED');
  assert.equal(row.signal_price, 66842);
  assert.equal(row.fill_price, 66900);
  assert.ok(JSON.parse(row.raw_json).response.fills.length === 1);
  db.close();
});

test('-1021 timestamp error triggers one resync and a retry that succeeds', async () => {
  const fetchImpl = createMockTestnetFetch({
    failFirstOrderWith: { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' },
  });
  const { ex, db } = makeExecutor({ fetchImpl });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const timeCallsBefore = fetchImpl.counters.time;

  const fill = await ex.buy('BTCUSDT', 0.004, 66900);
  assert.equal(fill.skipped, undefined);
  assert.ok(fill.orderId, 'order eventually filled');
  assert.equal(fetchImpl.counters.order, 2, 'order endpoint hit twice (fail + retry)');
  assert.equal(fetchImpl.counters.time, timeCallsBefore + 1, 'time was resynced exactly once');
  db.close();
});

test('reconcile flags STATE_MISMATCH when exchange balance disagrees with local cash', async () => {
  // local cash starts at 1000 (fresh portfolio); exchange reports 700
  const { ex, db } = makeExecutor({ mockOpts: { usdtBalance: 700 } });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  assert.equal(await ex.reconcile(db), false);
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'STATE_MISMATCH'").get();
  const detail = JSON.parse(ev.detail);
  assert.equal(detail.localCash, 1000);
  assert.equal(detail.exchangeUsdt, 700);

  // and agrees when balances match
  const { ex: ex2, db: db2 } = makeExecutor({ mockOpts: { usdtBalance: 1000 } });
  await ex2.init(['BTCUSDT', 'ETHUSDT']);
  assert.equal(await ex2.reconcile(db2), true);
  db.close();
  db2.close();
});
