// Binance SPOT TESTNET executor. Real order placement against a real order
// book, TESTNET FUNDS ONLY.
//
// Safety properties, in order of importance:
//   1. The base URL is a frozen constant — not in config, not env-overridable.
//      There is no way to point this executor at mainnet via configuration.
//   2. The constructor refuses any base URL that does not contain 'testnet'.
//   3. Keys come from BINANCE_TESTNET_API_KEY/SECRET, which mainnet rejects.
//   4. There is still NO live/mainnet executor anywhere in this codebase.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db.js';
import { getCash } from './portfolio.js';

// Frozen on purpose. Do not make this configurable.
export const TESTNET_BASE = 'https://testnet.binance.vision';

export function assertTestnetBase(url = TESTNET_BASE) {
  if (typeof url !== 'string' || !url.includes('testnet')) {
    throw new Error(`TestnetExecutor refuses non-testnet base URL: ${url}`);
  }
  return url;
}

// Binance HMAC-SHA256 request signing (signature over the raw query string).
export function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Floor a quantity to the symbol's LOT_SIZE stepSize. Never rounds up.
export function roundToStep(qty, stepSize) {
  const step = Number(stepSize);
  if (!(step > 0)) return qty;
  const decimals = (String(stepSize).split('.')[1] || '').replace(/0+$/, '').length;
  const floored = Math.floor(qty / step + 1e-9) * step;
  return Number(floored.toFixed(decimals));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class TestnetExecutor {
  constructor({
    apiKey = config.binanceTestnetApiKey,
    apiSecret = config.binanceTestnetApiSecret,
    fetchImpl = fetch,
    db = null,
  } = {}) {
    this.base = assertTestnetBase(TESTNET_BASE);
    if (!apiKey || !apiSecret) {
      throw new Error('EXECUTOR=testnet requires BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET (create them at testnet.binance.vision)');
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fetchImpl = fetchImpl;
    this._db = db;
    this.timeOffset = 0;
    this.filters = {}; // pair -> { stepSize, minQty, minNotional }
    this.recvWindow = 5000;
  }

  get db() {
    return this._db ?? getDb();
  }

  // Sync server time and load exchange filters. Call once per run.
  async init(pairs = config.pairs) {
    await this.syncTime();
    const info = await this.#public(`/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(pairs))}`);
    for (const sym of info.symbols || []) {
      const lot = (sym.filters || []).find((f) => f.filterType === 'LOT_SIZE') || {};
      const notional = (sym.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') || {};
      this.filters[sym.symbol] = {
        stepSize: lot.stepSize ?? '0.00000001',
        minQty: Number(lot.minQty ?? 0),
        minNotional: Number(notional.minNotional ?? 0),
      };
    }
  }

  async syncTime() {
    const data = await this.#public('/api/v3/time');
    this.timeOffset = Number(data.serverTime) - Date.now();
  }

  // Compare exchange quote balance with local cash at cycle start. On
  // disagreement beyond rounding: log STATE_MISMATCH and tell the caller to
  // halt new entries for this cycle. Never throws.
  async reconcile(db = this.db) {
    try {
      const account = await this.#signed('GET', '/api/v3/account', {});
      const usdt = Number((account.balances || []).find((b) => b.asset === 'USDT')?.free ?? NaN);
      const local = getCash(db);
      const tolerance = Math.max(1, local * 0.005);
      if (!Number.isFinite(usdt) || Math.abs(usdt - local) > tolerance) {
        logEvent('STATE_MISMATCH', { localCash: local, exchangeUsdt: usdt }, db);
        return false;
      }
      return true;
    } catch (err) {
      logEvent('STATE_MISMATCH', { error: String(err).slice(0, 300) }, db);
      return false;
    }
  }

  // Executor interface (same shape as PaperExecutor, plus executedQty/orderId).
  async buy(pair, qty, marketPrice) {
    return this.#marketOrder(pair, 'BUY', qty, marketPrice);
  }

  async sell(pair, qty, marketPrice) {
    return this.#marketOrder(pair, 'SELL', qty, marketPrice);
  }

  async #marketOrder(pair, side, qty, signalPrice) {
    const f = this.filters[pair];
    if (!f) throw new Error(`no exchange filters loaded for ${pair} — call init() first`);

    const quantity = roundToStep(qty, f.stepSize);
    // Below-minimum orders are skipped, never rounded up.
    if (quantity <= 0 || quantity < f.minQty || quantity * signalPrice < f.minNotional) {
      logEvent('ORDER_BELOW_MIN_NOTIONAL', { pair, side, qty, rounded: quantity, minQty: f.minQty, minNotional: f.minNotional, signalPrice }, this.db);
      return { pair, skipped: 'below_min_notional' };
    }

    const params = { symbol: pair, side, type: 'MARKET', quantity: String(quantity), newOrderRespType: 'FULL' };
    let data;
    try {
      data = await this.#signed('POST', '/api/v3/order', params);
    } catch (err) {
      this.#recordOrder({ pair, side, requestedQty: quantity, executedQty: null, signalPrice, fillPrice: null, status: 'ERROR', orderId: null, raw: { request: params, error: String(err).slice(0, 500) } });
      if (err.binanceCode === -2010) {
        logEvent('ORDER_REJECTED_INSUFFICIENT_BALANCE', { pair, side, quantity }, this.db);
        return { pair, skipped: 'insufficient_balance' };
      }
      if (err.binanceCode === -1013) {
        logEvent('ORDER_FILTER_FAILURE', { pair, side, quantity, error: String(err).slice(0, 200) }, this.db);
        return { pair, skipped: 'filter_failure' };
      }
      throw err;
    }

    // Actual fill data from the response — not our signal price.
    const executedQty = Number(data.executedQty);
    const quote = Number(data.cummulativeQuoteQty);
    const fillPrice = executedQty > 0 ? quote / executedQty : signalPrice;
    const fee = this.#feeInQuote(data.fills || [], pair, fillPrice);

    this.#recordOrder({ pair, side, requestedQty: quantity, executedQty, signalPrice, fillPrice, status: data.status, orderId: data.orderId, raw: { request: params, response: data } });

    if (data.status !== 'FILLED' || !(executedQty > 0)) {
      logEvent('ORDER_NOT_FILLED', { pair, side, quantity, status: data.status }, this.db);
      return { pair, skipped: 'not_filled' };
    }

    const common = { pair, fillPrice, fee, executedQty, orderId: data.orderId };
    return side === 'BUY'
      ? { ...common, notional: quote }
      : { ...common, proceeds: quote };
  }

  // Commission comes per-fill in varying assets. Convert to quote terms where
  // possible (base asset via fill price); other assets (e.g. BNB) are logged
  // raw in the orders table but excluded from the quote-fee figure.
  #feeInQuote(fills, pair, fallbackPrice) {
    const baseAsset = pair.replace(/USDT$|USDC$|BUSD$/, '');
    let fee = 0;
    for (const fill of fills) {
      const commission = Number(fill.commission) || 0;
      if (fill.commissionAsset === 'USDT' || fill.commissionAsset === 'USDC' || fill.commissionAsset === 'BUSD') {
        fee += commission;
      } else if (fill.commissionAsset === baseAsset) {
        fee += commission * (Number(fill.price) || fallbackPrice);
      }
    }
    return fee;
  }

  #recordOrder({ pair, side, requestedQty, executedQty, signalPrice, fillPrice, status, orderId, raw }) {
    try {
      this.db
        .prepare(
          `INSERT INTO orders (ts, pair, side, type, requested_qty, executed_qty, signal_price, fill_price, status, order_id, raw_json)
           VALUES (?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(nowIso(), pair, side, requestedQty, executedQty, signalPrice, fillPrice, status, orderId === null ? null : String(orderId), JSON.stringify(raw));
    } catch { /* audit logging must never break execution */ }
  }

  async #public(path) {
    const res = await this.fetchImpl(`${this.base}${path}`);
    if (!res.ok) throw new Error(`Binance testnet HTTP ${res.status} for ${path}`);
    return res.json();
  }

  async #signed(method, path, params, { maxAttempts = 4 } = {}) {
    let resynced = false;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const qs = new URLSearchParams({
        ...params,
        recvWindow: String(this.recvWindow),
        timestamp: String(Date.now() + this.timeOffset),
      }).toString();
      const url = `${this.base}${path}?${qs}&signature=${sign(qs, this.apiSecret)}`;

      let res;
      try {
        res = await this.fetchImpl(url, { method, headers: { 'X-MBX-APIKEY': this.apiKey } });
      } catch (err) {
        lastErr = err;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }

      const data = await res.json().catch(() => ({}));

      // Timestamp drift: resync once and retry.
      if (data && data.code === -1021 && !resynced) {
        resynced = true;
        await this.syncTime();
        continue;
      }
      if (!res.ok || (data && typeof data.code === 'number' && data.code < 0)) {
        const err = new Error(`Binance ${data.code ?? res.status}: ${data.msg ?? 'request failed'}`);
        err.binanceCode = data.code;
        throw err;
      }
      return data;
    }
    throw lastErr ?? new Error(`Binance testnet retries exhausted for ${path}`);
  }
}

// --- deterministic mock transport (tests + TRADEPILOT_MOCK demo cycles) ---
// Simulates the handful of testnet endpoints the executor touches. Fill
// prices sit slightly away from the synthetic signal so fill-vs-signal
// reporting has something to show.
export function createMockTestnetFetch({
  prices = { BTCUSDT: 66900, ETHUSDT: 3345 },
  usdtBalance = 1000,
  failFirstOrderWith = null, // e.g. { code: -1021, msg: 'Timestamp outside recvWindow' }
} = {}) {
  let nextOrderId = 1000;
  let pendingFailure = failFirstOrderWith;
  const counters = { time: 0, exchangeInfo: 0, account: 0, order: 0 };

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  const mockFetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/v3/time') {
      counters.time += 1;
      return json({ serverTime: Date.now() });
    }
    if (u.pathname === '/api/v3/exchangeInfo') {
      counters.exchangeInfo += 1;
      return json({
        symbols: Object.keys(prices).map((symbol) => ({
          symbol,
          filters: [
            { filterType: 'LOT_SIZE', stepSize: symbol === 'BTCUSDT' ? '0.00001000' : '0.00010000', minQty: symbol === 'BTCUSDT' ? '0.00001000' : '0.00010000' },
            { filterType: 'NOTIONAL', minNotional: '5.00000000' },
          ],
        })),
      });
    }
    if (u.pathname === '/api/v3/account') {
      counters.account += 1;
      return json({ balances: [{ asset: 'USDT', free: String(usdtBalance), locked: '0' }] });
    }
    if (u.pathname === '/api/v3/order' && (opts.method || 'GET') === 'POST') {
      counters.order += 1;
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = null;
        return json(failure, 400);
      }
      const symbol = u.searchParams.get('symbol');
      const side = u.searchParams.get('side');
      const qty = Number(u.searchParams.get('quantity'));
      const price = prices[symbol];
      const baseAsset = symbol.replace('USDT', '');
      return json({
        symbol,
        orderId: nextOrderId++,
        status: 'FILLED',
        side,
        executedQty: String(qty),
        cummulativeQuoteQty: String(qty * price),
        fills: [{ price: String(price), qty: String(qty), commission: String(qty * 0.001), commissionAsset: baseAsset }],
      });
    }
    return json({ code: -1100, msg: `mock: unhandled ${opts.method || 'GET'} ${u.pathname}` }, 400);
  };

  mockFetch.counters = counters;
  return mockFetch;
}
