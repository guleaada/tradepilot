// TradePilot entry point + orchestration loop.
//
//   npm start      -> continuous loop (one cycle every cycleMinutes)
//   npm run cycle  -> single pass (used by GitHub Actions)
//
// Defensive everywhere: a failure on one pair logs an event and the loop
// continues. The process never crashes the loop on network/AI/DB errors.
import { config } from './config.js';
import { closeDb, getDb, logEvent } from './db.js';
import { getFundingRate, getKlines, getTicker24h } from './data/binance.js';
import { atr, ema, last, rsi, volatility } from './indicators.js';
import { buildMarketSummary, getRegime } from './ai/regime.js';
import { getSentiment } from './ai/sentiment.js';
import { PaperExecutor } from './engine/executor.js';
import { runPairRules } from './engine/rules.js';
import { getCash, getEquity, snapshotEquity } from './engine/portfolio.js';
import { consoleSummary } from './report/daily.js';

const executor = new PaperExecutor();

async function loadMarket(pair) {
  const [k1h, k4h, ticker, fundingRate] = await Promise.all([
    getKlines(pair, '1h'),
    getKlines(pair, '4h'),
    getTicker24h(pair),
    getFundingRate(pair),
  ]);
  const closes1h = k1h.map((k) => k.close);
  const closes4h = k4h.map((k) => k.close);
  const price = ticker.lastPrice || closes1h[closes1h.length - 1];
  return {
    price,
    last5: k1h.slice(-5).map((k) => ({
      o: +k.open.toFixed(2), h: +k.high.toFixed(2), l: +k.low.toFixed(2), c: +k.close.toFixed(2),
    })),
    rsi1h: last(rsi(closes1h, 14)),
    atr1h: last(atr(k1h, 14)),
    ema20_1h: last(ema(closes1h, 20)),
    ema50_1h: last(ema(closes1h, 50)),
    ema200_1h: last(ema(closes1h, 200)),
    ema20_4h: last(ema(closes4h, 20)),
    ema50_4h: last(ema(closes4h, 50)),
    ema200_4h: last(ema(closes4h, 200)),
    vol20: volatility(closes1h, 20),
    change24hPct: ticker.priceChangePercent,
    volume24h: ticker.quoteVolume,
    fundingRate,
  };
}

export async function runCycle() {
  const db = getDb();
  const prices = {};

  for (const pair of config.pairs) {
    try {
      const market = await loadMarket(pair);
      prices[pair] = market.price;

      const recentCalls = db
        .prepare('SELECT ts, regime, confidence, trade_allowed FROM regime_calls WHERE pair = ? ORDER BY id DESC LIMIT 3')
        .all(pair);
      const recentTrades = db
        .prepare("SELECT exit_time, pnl, exit_reason FROM trades WHERE pair = ? AND status = 'closed' ORDER BY id DESC LIMIT 3")
        .all(pair);
      // Grok sentiment runs immediately before the Claude regime call, same
      // cadence; never a blocker — failures degrade to neutral/unavailable.
      const sentiment = await getSentiment(pair, db);
      const summary = buildMarketSummary(pair, market, recentCalls, recentTrades, sentiment);
      const regime = await getRegime(pair, summary, db);

      const actions = runPairRules({
        pair,
        price: market.price,
        atr1h: market.atr1h,
        rsi1h: market.rsi1h,
        ema50_4h: market.ema50_4h,
        regime,
        executor,
        db,
        prices,
      });
      for (const a of actions) {
        if (a.type === 'open') {
          console.log(`[${pair}] OPEN qty=${a.qty.toFixed(6)} entry=${a.entry.toFixed(2)} stop=${a.stop.toFixed(2)} tp=${a.tp.toFixed(2)}`);
        } else if (a.type === 'close') {
          console.log(`[${pair}] CLOSE reason=${a.reason} pnl=$${a.pnl.toFixed(2)}`);
        } else {
          console.log(`[${pair}] no entry (${a.reason}) | regime=${regime.regime}/${regime.confidence} price=${market.price.toFixed(2)} rsi1h=${market.rsi1h?.toFixed(1)}`);
        }
      }
    } catch (err) {
      console.error(`[${pair}] cycle error:`, err.message);
      try {
        logEvent('ERROR', { pair, error: String(err).slice(0, 500) }, db);
      } catch { /* never let logging kill the loop */ }
    }
  }

  try {
    snapshotEquity(getEquity(prices, db), getCash(db), db);
  } catch (err) {
    console.error('snapshot error:', err.message);
  }
  consoleSummary(prices, db);
}

async function main() {
  const once = process.argv.includes('--once');
  console.log(`TradePilot — PAPER TRADING ONLY${config.mock ? ' [MOCK DATA]' : ''}`);
  console.log(`pairs: ${config.pairs.join(', ')} | cycle: ${config.cycleMinutes}m | AI cadence: ${config.aiCadenceHours}h | budget: $${config.aiDailyBudgetUsd}/day`);

  await runCycle();
  if (once) {
    closeDb();
    return;
  }
  setInterval(() => {
    runCycle().catch((err) => console.error('cycle failed:', err.message));
  }, config.cycleMinutes * 60_000);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
