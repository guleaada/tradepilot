// TradePilot entry point + orchestration loop.
//
//   npm start      -> continuous loop (one cycle every cycleMinutes)
//   npm run cycle  -> single pass (used by GitHub Actions)
//
// Defensive everywhere: a failure on one pair logs an event and the loop
// continues. The process never crashes the loop on network/AI/DB errors.
import fs from 'node:fs';
import { config } from './config.js';
import { closeDb, getDb, logEvent, nowIso } from './db.js';
import { getDailyKlines, getFundingRate, getKlines, getTicker24h } from './data/binance.js';
import { atr, correlation, ema, last, returns, rsi, sma, volatility } from './indicators.js';
import { buildMarketSummary, getRegime, regimeCallOutcomes } from './ai/regime.js';
import { getSentiment } from './ai/sentiment.js';
import { sendAlert } from './alert.js';
import { PaperExecutor } from './engine/executor.js';
import { assertTestnetBase, createMockTestnetFetch, TESTNET_BASE, TestnetExecutor } from './engine/testnetExecutor.js';
import { dynamicRsiBounds, runPairRules } from './engine/rules.js';
import {
  drawdownFromPeak,
  getCash,
  getEquity,
  getOpenPositions,
  snapshotEquity,
  todayPnl,
  trailing7dStats,
  volTargetScaleFromDb,
} from './engine/portfolio.js';
import { consoleSummary } from './report/daily.js';
import { getDailySpend } from './ai/budget.js';

// Selected in main(). Default is the paper simulator; 'testnet' requires the
// hard-coded testnet base URL to pass the mainnet guard. No live executor
// exists in this codebase.
let executor = new PaperExecutor();
let activePairs = config.pairs;

function buildExecutor() {
  if (config.executor === 'paper') return new PaperExecutor();
  if (config.executor === 'testnet') {
    assertTestnetBase(TESTNET_BASE); // refuse to start unless the URL is testnet
    console.log('EXECUTOR: BINANCE SPOT TESTNET — no real funds');
    if (config.mock) {
      return new TestnetExecutor({ apiKey: 'mock', apiSecret: 'mock', fetchImpl: createMockTestnetFetch() });
    }
    return new TestnetExecutor();
  }
  throw new Error(`unknown EXECUTOR "${config.executor}" — use "paper" or "testnet"`);
}

// 7a: refuse to trade on a corrupted database.
function checkDbIntegrity(db) {
  const rows = db.pragma('integrity_check');
  const result = rows?.[0]?.integrity_check ?? 'unknown';
  if (result !== 'ok') {
    console.error(`CRITICAL: SQLite integrity_check failed: ${result}`);
    process.exit(1);
  }
}

// 7c: drop illiquid pairs for this run.
async function filterPairsByLiquidity(db) {
  const kept = [];
  for (const pair of config.pairs) {
    try {
      const ticker = await getTicker24h(pair);
      if (ticker.quoteVolume >= config.liquidityMinVolume24h) {
        kept.push(pair);
      } else {
        logEvent('PAIR_EXCLUDED', { pair, quoteVolume24h: ticker.quoteVolume, min: config.liquidityMinVolume24h }, db);
        console.log(`[${pair}] excluded: 24h quote volume ${Math.round(ticker.quoteVolume).toLocaleString()} < ${config.liquidityMinVolume24h.toLocaleString()}`);
      }
    } catch (err) {
      kept.push(pair); // lenient: a ticker failure never silently drops a pair
      logEvent('ERROR', { pair, error: `liquidity check failed: ${String(err).slice(0, 200)}` }, db);
    }
  }
  return kept;
}

async function loadMarket(pair) {
  const [k1h, k4h, kDaily, ticker, fundingRate] = await Promise.all([
    getKlines(pair, '1h'),
    getKlines(pair, '4h'),
    getDailyKlines(pair),
    getTicker24h(pair),
    getFundingRate(pair),
  ]);
  const closes1h = k1h.map((k) => k.close);
  const closes4h = k4h.map((k) => k.close);
  const closesDaily = kDaily.map((k) => k.close);
  const volumes1h = k1h.map((k) => k.volume);
  const volSma20 = last(sma(volumes1h, 20));
  const price = ticker.lastPrice || closes1h[closes1h.length - 1];
  return {
    price,
    closes1h,
    last5: k1h.slice(-5).map((k) => ({
      o: +k.open.toFixed(2), h: +k.high.toFixed(2), l: +k.low.toFixed(2), c: +k.close.toFixed(2),
    })),
    rsi1h: last(rsi(closes1h, 14)),
    atr1h: last(atr(k1h, 14)),
    atrSeries1h: atr(k1h, 14),
    ema20_1h: last(ema(closes1h, 20)),
    ema50_1h: last(ema(closes1h, 50)),
    ema200_1h: last(ema(closes1h, 200)),
    ema20_4h: last(ema(closes4h, 20)),
    ema50_4h: last(ema(closes4h, 50)),
    ema200_4h: last(ema(closes4h, 200)),
    dailyEma50: last(ema(closesDaily, 50)),
    volumeRatio: volSma20 > 0 ? volumes1h[volumes1h.length - 1] / volSma20 : null,
    vol20: volatility(closes1h, 20),
    change24hPct: ticker.priceChangePercent,
    volume24h: ticker.quoteVolume,
    fundingRate,
  };
}

// 1g: is the candidate pair too correlated with any currently open position?
function correlationBlockedFor(pair, markets, db, cfg = config) {
  if (!cfg.correlationFilterEnabled) return false;
  const candidate = markets[pair];
  if (!candidate) return false;
  const candReturns = returns(candidate.closes1h.slice(-21)); // 20-period return correlation
  for (const pos of getOpenPositions(db)) {
    if (pos.pair === pair) continue;
    const other = markets[pos.pair];
    if (!other) continue;
    const corr = correlation(candReturns, returns(other.closes1h.slice(-21)));
    if (corr !== null && corr >= cfg.correlationMax) {
      logEvent('CORRELATION_BLOCKED', { pair, against: pos.pair, correlation: Number(corr.toFixed(3)) }, db);
      return true;
    }
  }
  return false;
}

function btcDominanceApprox(markets) {
  const btc = markets.BTCUSDT;
  if (!btc) return null;
  const total = Object.values(markets).reduce((s, m) => s + (m.volume24h || 0), 0);
  return total > 0 ? Number(((btc.volume24h / total) * 100).toFixed(2)) : null;
}

async function maybeSendDailySummaryAlert(db) {
  const today = new Date().toISOString().slice(0, 10);
  const sent = db
    .prepare("SELECT id FROM events WHERE type = 'ALERT_DAILY_SUMMARY' AND ts >= ? LIMIT 1")
    .get(`${today}T00:00:00`);
  if (sent) return;
  const equity = getEquity({}, db);
  const open = getOpenPositions(db).length;
  const ok = await sendAlert(
    `📊 TradePilot daily summary ${today}\nequity $${equity.toFixed(2)} | open positions ${open} | today P&L $${todayPnl(db).toFixed(2)}\nAI spend today: claude $${getDailySpend(db, today, 'anthropic').toFixed(4)} / grok $${getDailySpend(db, today, 'grok').toFixed(4)}`,
  );
  if (ok) logEvent('ALERT_DAILY_SUMMARY', { date: today }, db);
}

async function sendEventAlerts(db, cycleStartIso) {
  const rows = db
    .prepare("SELECT type, detail FROM events WHERE ts >= ? AND type IN ('RISK_HALT', 'REGIME_PARSE_FAILURE')")
    .all(cycleStartIso);
  for (const row of rows) {
    await sendAlert(`⚠️ TradePilot ${row.type}: ${row.detail}`);
  }
  // 3rd consecutive budget skip today -> one alert.
  const today = new Date().toISOString().slice(0, 10);
  const skips = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'BUDGET_SKIPPED' AND ts >= ?")
    .get(`${today}T00:00:00`).n;
  if (skips === 3) {
    const newSkip = db
      .prepare("SELECT id FROM events WHERE type = 'BUDGET_SKIPPED' AND ts >= ? LIMIT 1")
      .get(cycleStartIso);
    if (newSkip) await sendAlert('⚠️ TradePilot: 3rd consecutive BUDGET_SKIPPED today — Claude regime calls are budget-starved.');
  }
}

export async function runCycle() {
  const db = getDb();
  const cycleStartIso = nowIso();
  const prices = {};
  const markets = {};

  // 7a: refresh the on-disk backup before touching anything.
  if (config.dbPath !== ':memory:' && fs.existsSync(config.dbPath)) {
    try {
      await db.backup(`${config.dbPath}.bak`);
    } catch (err) {
      console.error('db backup failed:', err.message);
    }
  }

  await maybeSendDailySummaryAlert(db);

  // Testnet: reconcile local cash against exchange balances at cycle start.
  // On STATE_MISMATCH, exits still run but new entries are blocked this cycle.
  let entriesBlocked = false;
  if (typeof executor.reconcile === 'function') {
    entriesBlocked = !(await executor.reconcile(db));
    if (entriesBlocked) console.warn('STATE_MISMATCH: blocking new entries this cycle (see events table)');
  }

  // Phase 1: load market data for every active pair (needed up front so the
  // correlation filter and BTC dominance can see all pairs at once).
  for (const pair of activePairs) {
    try {
      markets[pair] = await loadMarket(pair);
      prices[pair] = markets[pair].price;
    } catch (err) {
      console.error(`[${pair}] market load error:`, err.message);
      try {
        logEvent('ERROR', { pair, error: String(err).slice(0, 500) }, db);
      } catch { /* never let logging kill the loop */ }
    }
  }

  const volScale = volTargetScaleFromDb(db, config);
  if (volScale < 1) console.log(`volatility targeting: scaling new positions by ${volScale.toFixed(2)}`);

  // Phase 2: AI opinions + deterministic rules per pair.
  for (const pair of activePairs) {
    const market = markets[pair];
    if (!market) continue;
    try {
      const sentiment = await getSentiment(pair, db);
      const stats7d = trailing7dStats(db);
      const context = {
        portfolio_drawdown_pct: Number((drawdownFromPeak(db) * 100).toFixed(2)),
        btc_volume_dominance_pct_approx: btcDominanceApprox(markets),
        win_rate_7d: stats7d.winRate,
        profit_factor_7d: stats7d.profitFactor === Infinity ? 'inf' : stats7d.profitFactor,
      };
      const recentCalls = regimeCallOutcomes(pair, db, 5);
      const recentTrades = db
        .prepare("SELECT exit_time, pnl, exit_reason FROM trades WHERE pair = ? AND status = 'closed' ORDER BY id DESC LIMIT 3")
        .all(pair);
      const summary = buildMarketSummary(pair, market, recentCalls, recentTrades, sentiment, context);
      const regime = await getRegime(pair, summary, db);

      const actions = await runPairRules({
        pair,
        price: market.price,
        atr1h: market.atr1h,
        rsi1h: market.rsi1h,
        ema50_4h: market.ema50_4h,
        dailyEma50: market.dailyEma50,
        volumeRatio: market.volumeRatio,
        rsiBounds: dynamicRsiBounds(market.atrSeries1h, config),
        correlationBlocked: correlationBlockedFor(pair, markets, db, config),
        regime,
        sentiment,
        executor,
        db,
        prices,
        entriesBlocked,
        volScale,
      });
      for (const a of actions) {
        if (a.type === 'open') {
          const slipBps = ((a.entry / a.signal - 1) * 10_000).toFixed(1);
          console.log(`[${pair}] OPEN qty=${a.qty.toFixed(6)} fill=${a.entry.toFixed(2)} (signal ${a.signal.toFixed(2)}, ${slipBps}bps) stop=${a.stop.toFixed(2)} tp=${a.tp.toFixed(2)}`);
          await sendAlert(`🟢 OPEN ${pair} qty ${a.qty.toFixed(6)} @ ${a.entry.toFixed(2)} | stop ${a.stop.toFixed(2)} | tp ${a.tp.toFixed(2)}`);
        } else if (a.type === 'close') {
          const slipBps = ((a.exit / a.signal - 1) * 10_000).toFixed(1);
          console.log(`[${pair}] CLOSE reason=${a.reason} pnl=$${a.pnl.toFixed(2)} fill=${a.exit.toFixed(2)} (signal ${a.signal.toFixed(2)}, ${slipBps}bps)`);
          const emoji = a.reason === 'emergency_exit' ? '🚨' : a.pnl >= 0 ? '✅' : '🔻';
          await sendAlert(`${emoji} CLOSE ${pair} (${a.reason}) P&L $${a.pnl.toFixed(2)} @ ${a.exit.toFixed(2)}`);
        } else if (a.type === 'partial_exit') {
          console.log(`[${pair}] PARTIAL EXIT sold=${a.soldQty.toFixed(6)} pnl=$${a.partialPnl.toFixed(2)} new tp=${a.newTp.toFixed(2)}`);
          await sendAlert(`🟡 PARTIAL EXIT ${pair} sold ${a.soldQty.toFixed(6)} P&L $${a.partialPnl.toFixed(2)} | remainder TP ${a.newTp.toFixed(2)}`);
        } else if (a.type === 'breakeven') {
          console.log(`[${pair}] STOP -> BREAKEVEN at ${a.newStop.toFixed(2)}`);
        } else if (a.type === 'exit_skipped') {
          console.log(`[${pair}] EXIT SKIPPED (${a.reason}) — position stays open, retrying next cycle`);
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
    await sendEventAlerts(db, cycleStartIso);
  } catch (err) {
    console.error('snapshot/alert error:', err.message);
  }
  consoleSummary(prices, db);
}

async function main() {
  const once = process.argv.includes('--once');
  console.log(`TradePilot — NO REAL FUNDS (executor: ${config.executor})${config.mock ? ' [MOCK DATA]' : ''}`);
  console.log(`pairs: ${config.pairs.join(', ')} | cycle: ${config.cycleMinutes}m | AI cadence: ${config.aiCadenceHours}h | budget: $${config.aiDailyBudgetUsd}/day`);

  const db = getDb();
  checkDbIntegrity(db);

  executor = buildExecutor();
  if (typeof executor.init === 'function') await executor.init();

  activePairs = await filterPairsByLiquidity(db);
  console.log(`active pairs after liquidity filter: ${activePairs.join(', ') || '(none)'}`);

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
