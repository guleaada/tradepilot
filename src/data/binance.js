// Binance public market data client. Real prices, no API key.
// Polite: per-URL cache (never refetch the same endpoint inside minPollMs)
// and exponential backoff on 429/418.
import { config } from '../config.js';

const cache = new Map(); // url -> { ts, data }

async function fetchJson(url, { maxAttempts = 5, ttl = config.minPollMs } = {}) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = await res.json();
      cache.set(url, { ts: Date.now(), data });
      return data;
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr ?? new Error(`fetch failed: ${url}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseKline(k) {
  return {
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  };
}

export async function getKlines(pair, interval, limit = config.klineLimit, { ttl } = {}) {
  if (config.mock) return mockKlines(pair, interval, limit);
  const url = `${config.binanceBase}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const raw = await fetchJson(url, { ttl });
  return raw.map(parseKline);
}

// Daily candles change slowly — cache them for an hour instead of one minute.
export async function getDailyKlines(pair, limit = config.klineLimit) {
  return getKlines(pair, '1d', limit, { ttl: 3_600_000 });
}

// Historical range fetch for the backtester (paginates past the 1000/req cap).
export async function getKlinesRange(pair, interval, startMs, endMs) {
  const stepMs = interval === '1d' ? 86_400_000 : interval === '4h' ? 14_400_000 : 3_600_000;
  if (config.mock) {
    const count = Math.floor((endMs - startMs) / stepMs);
    return mockKlines(pair, interval, count);
  }
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${config.binanceBase}/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const raw = await fetchJson(url, { ttl: Infinity });
    if (!raw.length) break;
    out.push(...raw.map(parseKline));
    const lastClose = raw[raw.length - 1][6];
    if (lastClose <= cursor) break;
    cursor = lastClose + 1;
  }
  return out;
}

export async function getTicker24h(pair) {
  if (config.mock) return mockTicker(pair);
  const url = `${config.binanceBase}/api/v3/ticker/24hr?symbol=${pair}`;
  const raw = await fetchJson(url);
  return {
    lastPrice: Number(raw.lastPrice),
    priceChangePercent: Number(raw.priceChangePercent),
    volume: Number(raw.volume),
    quoteVolume: Number(raw.quoteVolume),
  };
}

// Funding rate comes from the futures API. Degrade gracefully: return null on
// any failure and let the AI prompt note that funding data is unavailable.
export async function getFundingRate(pair) {
  if (config.mock) return 0.0001;
  try {
    const url = `${config.binanceFapiBase}/fapi/v1/premiumIndex?symbol=${pair}`;
    const raw = await fetchJson(url, { maxAttempts: 2 });
    const rate = Number(raw.lastFundingRate);
    return Number.isFinite(rate) ? rate : null;
  } catch {
    return null;
  }
}

// --- mock data (deterministic, used by tests and the demo cycle) ---

const MOCK_BASE = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150, BNBUSDT: 600, XRPUSDT: 0.5 };
// Distinct oscillation phases per pair so mock pairs are not perfectly
// correlated (lets the correlation filter behave realistically in demos).
const MOCK_PHASE = { BTCUSDT: 0, ETHUSDT: 1.6, SOLUSDT: 3.1, BNBUSDT: 4.7, XRPUSDT: 0.8 };

export function mockKlines(pair, interval, limit = 200) {
  const base = MOCK_BASE[pair] ?? 100;
  const phase = MOCK_PHASE[pair] ?? 0;
  const stepMs = interval === '1d' ? 86_400_000 : interval === '4h' ? 4 * 3600_000 : 3600_000;
  const start = Date.UTC(2026, 0, 1);
  const candles = [];
  let prevClose = base;
  for (let i = 0; i < limit; i++) {
    // Gentle uptrend with an oscillation: keeps price above EMA50 while RSI
    // stays out of overbought territory.
    const close = base * (1 + 0.0006 * i + 0.012 * Math.sin(i / 4 + phase));
    const open = prevClose;
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    candles.push({
      openTime: start + i * stepMs,
      open,
      high,
      low,
      close,
      // Mild exponential growth keeps the latest volume ~12% above its
      // 20-period average, so the volume-confirmation filter can pass.
      volume: 500 * 1.012 ** i + 20 * Math.sin(i / 5 + phase),
      closeTime: start + (i + 1) * stepMs - 1,
    });
    prevClose = close;
  }
  return candles;
}

function mockTicker(pair) {
  const klines = mockKlines(pair, '1h', 200);
  const lastPrice = klines[klines.length - 1].close;
  // Mock quote volumes put SOL/BNB/XRP below the 50M liquidity threshold on
  // purpose, so the PAIR_EXCLUDED path is exercised in demos.
  return { lastPrice, priceChangePercent: 2.4, volume: 24000, quoteVolume: lastPrice * 24000 };
}
