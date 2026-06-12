// Historical backtester. Replays 1h candles through the SAME indicators.js +
// rules.js logic the live loop uses, with the PaperExecutor fill model
// (slippage + fees). Results land in a separate timestamped SQLite DB.
//
//   npm run backtest -- --days 90 --pair BTCUSDT --mock-regime
//   npm run backtest -- --grid-search --mock-regime
//
// Indicator arrays are computed ONCE over the full series; RSI/EMA/ATR are
// recursive, so the value at index i depends only on candles <= i — no
// lookahead. Without --mock-regime, Claude is called on the 4h sim-time
// cadence and today's real budget cap applies (a 90-day replay can hit the
// cap quickly — --mock-regime is recommended for research runs).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { getKlinesRange } from './data/binance.js';
import { atr, correlation, ema, returns, rsi, sma, stdev } from './indicators.js';
import { buildMarketSummary, getRegime } from './ai/regime.js';
import { PaperExecutor } from './engine/executor.js';
import { dynamicRsiBounds, runPairRules } from './engine/rules.js';
import { getCash, getEquity, snapshotEquity, volTargetScale } from './engine/portfolio.js';

const WARMUP = 200; // need 50 completed 4h candles for the 4h EMA(50)

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 90, pairs: null, mockRegime: false, gridSearch: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]) || 90;
    else if (argv[i] === '--pair') args.pairs = [argv[++i]];
    else if (argv[i] === '--mock-regime') args.mockRegime = true;
    else if (argv[i] === '--grid-search') args.gridSearch = true;
  }
  return args;
}

// Precompute per-pair indicator series over the full history (no lookahead —
// all are rolling/recursive). Higher-timeframe values are mapped back to the
// 1h index of their last COMPLETED candle.
export function precompute(candles) {
  const closes = candles.map((k) => k.close);
  const volumes = candles.map((k) => k.volume);
  const closes4h = [];
  const closesDaily = [];
  for (let i = 3; i < candles.length; i += 4) closes4h.push(closes[i]);
  for (let i = 23; i < candles.length; i += 24) closesDaily.push(closes[i]);
  const ema50_4h = ema(closes4h, 50);
  const ema50Daily = ema(closesDaily, 50);
  const volSma = sma(volumes, 20);
  return {
    candles,
    closes,
    rsiArr: rsi(closes, 14),
    atrArr: atr(candles, 14),
    ema4hAt: (i) => {
      const idx = Math.floor((i + 1) / 4) - 1;
      return idx >= 0 && idx < ema50_4h.length ? ema50_4h[idx] : null;
    },
    dailyEmaAt: (i) => {
      const idx = Math.floor((i + 1) / 24) - 1;
      return idx >= 0 && idx < ema50Daily.length ? ema50Daily[idx] : null;
    },
    volRatioAt: (i) => (volSma[i] > 0 ? volumes[i] / volSma[i] : null),
  };
}

const MOCK_REGIME = Object.freeze({
  regime: 'bullish',
  confidence: 72,
  trade_allowed: true,
  reasoning: 'backtest mock regime',
});

async function regimeFor(pair, pre, i, simNow, db, mockRegime) {
  if (mockRegime) return MOCK_REGIME;
  const market = {
    price: pre.closes[i],
    last5: [],
    rsi1h: pre.rsiArr[i],
    atr1h: pre.atrArr[i],
    ema20_1h: null, ema50_1h: null, ema200_1h: null,
    ema20_4h: null, ema50_4h: pre.ema4hAt(i), ema200_4h: null,
    vol20: null, change24hPct: null, volume24h: null, fundingRate: null,
  };
  const summary = buildMarketSummary(pair, market, [], []);
  return getRegime(pair, summary, db, simNow);
}

export async function replay({ history, days, pairs, mockRegime = true, cfg = config, dbPath = ':memory:', quiet = true }) {
  const db = openDb(dbPath);
  const executor = new PaperExecutor({ slippage: cfg.slippage, takerFee: cfg.takerFee });
  const pre = {};
  for (const pair of pairs) pre[pair] = precompute(history[pair]);

  const maxLen = Math.max(...pairs.map((p) => history[p].length));
  const equitySeries = [cfg.startBalance];

  for (let i = WARMUP; i < maxLen; i++) {
    const prices = {};
    for (const pair of pairs) {
      if (i < history[pair].length) prices[pair] = pre[pair].closes[i];
    }
    const volScale = volTargetScale(equitySeries, cfg);

    for (const pair of pairs) {
      if (i >= history[pair].length) continue;
      const p = pre[pair];
      const simNow = history[pair][i].closeTime;
      const regime = await regimeFor(pair, p, i, simNow, db, mockRegime);

      // correlation vs open positions, using trailing 21 closes
      let correlationBlocked = false;
      if (cfg.correlationFilterEnabled) {
        const open = db.prepare("SELECT pair FROM trades WHERE status = 'open'").all();
        const candReturns = returns(p.closes.slice(Math.max(0, i - 20), i + 1));
        for (const pos of open) {
          if (pos.pair === pair || !pre[pos.pair]) continue;
          const corr = correlation(candReturns, returns(pre[pos.pair].closes.slice(Math.max(0, i - 20), i + 1)));
          if (corr !== null && corr >= cfg.correlationMax) {
            correlationBlocked = true;
            break;
          }
        }
      }

      await runPairRules({
        pair,
        price: p.closes[i],
        atr1h: p.atrArr[i],
        rsi1h: p.rsiArr[i],
        ema50_4h: p.ema4hAt(i),
        dailyEma50: p.dailyEmaAt(i),
        volumeRatio: p.volRatioAt(i),
        rsiBounds: dynamicRsiBounds(p.atrArr.slice(Math.max(0, i - 335), i + 1), cfg),
        correlationBlocked,
        regime,
        sentiment: null,
        executor,
        db,
        cfg,
        prices,
        volScale,
        now: simNow,
      });
    }

    const equity = getEquity(prices, db);
    equitySeries.push(equity);
    const ts = new Date(history[pairs[0]][Math.min(i, history[pairs[0]].length - 1)].closeTime).toISOString();
    snapshotEquity(equity, getCash(db), db, ts);
  }

  const metrics = computeMetrics(db, cfg);
  if (dbPath !== ':memory:') saveMetrics(db, metrics);
  if (!quiet) printMetrics(metrics, { days, pairs, mockRegime, dbPath });
  if (dbPath === ':memory:') db.close();
  return metrics;
}

export function computeMetrics(db, cfg = config) {
  const snaps = db.prepare('SELECT equity FROM equity_snapshots ORDER BY id').all().map((r) => r.equity);
  const series = [cfg.startBalance, ...snaps];
  const totalReturn = series[series.length - 1] / series[0] - 1;
  const hours = Math.max(1, series.length - 1);
  const annualized = (1 + totalReturn) ** (8760 / hours) - 1;

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const eq of series) {
    peak = Math.max(peak, eq);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - eq) / peak);
  }

  const rets = returns(series);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = stdev(rets);
  const downside = rets.filter((r) => r < 0);
  const downsideSd = downside.length
    ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length)
    : null;
  const ann = Math.sqrt(8760);
  const sharpe = sd > 0 ? (mean / sd) * ann : null;
  const sortino = downsideSd > 0 ? (mean / downsideSd) * ann : null;

  const closed = db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY id").all();
  const wins = closed.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  let curW = 0; let curL = 0; let maxW = 0; let maxL = 0;
  for (const t of closed) {
    if (t.pnl > 0) { curW++; curL = 0; } else { curL++; curW = 0; }
    maxW = Math.max(maxW, curW);
    maxL = Math.max(maxL, curL);
  }
  const holdMins = closed
    .map((t) => (Date.parse(t.exit_time) - Date.parse(t.entry_time)) / 60_000)
    .filter(Number.isFinite);
  const riskHalts = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'RISK_HALT'").get().n;

  return {
    total_return_pct: totalReturn * 100,
    annualized_return_pct: annualized * 100,
    max_drawdown_pct: maxDrawdown * 100,
    sharpe_ratio: sharpe,
    sortino_ratio: sortino,
    trades: closed.length,
    win_rate: closed.length ? wins.length / closed.length : null,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancy_per_trade: closed.length ? closed.reduce((a, t) => a + t.pnl, 0) / closed.length : null,
    avg_holding_minutes: holdMins.length ? holdMins.reduce((a, b) => a + b, 0) / holdMins.length : null,
    max_consecutive_wins: maxW,
    max_consecutive_losses: maxL,
    risk_halt_events: riskHalts,
    final_equity: series[series.length - 1],
  };
}

function saveMetrics(db, metrics) {
  db.exec('CREATE TABLE IF NOT EXISTS backtest_metrics (metric TEXT PRIMARY KEY, value REAL)');
  const insert = db.prepare('INSERT OR REPLACE INTO backtest_metrics (metric, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(metrics)) {
    insert.run(key, Number.isFinite(value) ? value : null);
  }
}

const fmt = (v, d = 2) => (v === null || v === undefined ? 'n/a' : v === Infinity ? '∞' : Number(v).toFixed(d));

function printMetrics(m, { days, pairs, mockRegime, dbPath }) {
  console.log(`\n── Backtest results ─ ${pairs.join(', ')} ─ ${days}d ─ regime: ${mockRegime ? 'mock' : 'claude'} ──`);
  console.log(`total return     ${fmt(m.total_return_pct)}%      annualized ${fmt(m.annualized_return_pct)}%`);
  console.log(`max drawdown     ${fmt(m.max_drawdown_pct)}%      sharpe ${fmt(m.sharpe_ratio)}   sortino ${fmt(m.sortino_ratio)}`);
  console.log(`trades ${m.trades}   win rate ${fmt(m.win_rate === null ? null : m.win_rate * 100, 1)}%   profit factor ${fmt(m.profit_factor)}   expectancy $${fmt(m.expectancy_per_trade)}`);
  console.log(`avg hold ${fmt(m.avg_holding_minutes, 0)}min   max consec W/L ${m.max_consecutive_wins}/${m.max_consecutive_losses}   risk halts ${m.risk_halt_events}`);
  console.log(`final equity $${fmt(m.final_equity)}   db: ${dbPath}`);
}

// 3c: parameter grid search, ranked by Sharpe. Reports only — never applies.
const GRID = {
  stopAtrMult: [1.0, 1.5, 2.0],
  tpAtrMult: [2.0, 2.5, 3.0, 4.0],
  rsiEntryMin: [40, 45, 48],
  regimeMinConfidence: [55, 60, 65, 70],
};

async function gridSearch({ history, days, pairs }) {
  const rows = [];
  let n = 0;
  const total = GRID.stopAtrMult.length * GRID.tpAtrMult.length * GRID.rsiEntryMin.length * GRID.regimeMinConfidence.length;
  for (const stopAtrMult of GRID.stopAtrMult) {
    for (const tpAtrMult of GRID.tpAtrMult) {
      for (const rsiEntryMin of GRID.rsiEntryMin) {
        for (const regimeMinConfidence of GRID.regimeMinConfidence) {
          const combo = { stopAtrMult, tpAtrMult, rsiEntryMin, regimeMinConfidence };
          const metrics = await replay({
            history, days, pairs, mockRegime: true,
            cfg: { ...config, ...combo },
            dbPath: ':memory:', quiet: true,
          });
          rows.push({ ...combo, ...metrics });
          n++;
          if (n % 24 === 0) console.log(`grid search: ${n}/${total} combos done`);
        }
      }
    }
  }
  rows.sort((a, b) => (b.sharpe_ratio ?? -Infinity) - (a.sharpe_ratio ?? -Infinity));

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(config.reportsDir, `grid_search_${date}.html`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Grid search ${date}</title>
<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 10px;font-size:13px;text-align:right}th{background:#f3f4f6}</style>
</head><body><h1>TradePilot grid search — ${pairs.join(', ')} — ${days}d (mock regime)</h1>
<p>Ranked by Sharpe ratio. <strong>Best parameters are reported only — never auto-applied.</strong></p>
<table><tr><th>#</th><th>stop ATR</th><th>tp ATR</th><th>RSI min</th><th>conf min</th><th>Sharpe</th><th>Sortino</th><th>Return %</th><th>Max DD %</th><th>Trades</th><th>Win %</th><th>PF</th></tr>
${rows.map((r, idx) => `<tr><td>${idx + 1}</td><td>${r.stopAtrMult}</td><td>${r.tpAtrMult}</td><td>${r.rsiEntryMin}</td><td>${r.regimeMinConfidence}</td><td>${fmt(r.sharpe_ratio)}</td><td>${fmt(r.sortino_ratio)}</td><td>${fmt(r.total_return_pct)}</td><td>${fmt(r.max_drawdown_pct)}</td><td>${r.trades}</td><td>${fmt(r.win_rate === null ? null : r.win_rate * 100, 1)}</td><td>${fmt(r.profit_factor)}</td></tr>`).join('\n')}
</table></body></html>`;
  fs.mkdirSync(config.reportsDir, { recursive: true });
  fs.writeFileSync(file, html);
  console.log(`\ngrid search complete: ${rows.length} combos. Best Sharpe: ${fmt(rows[0]?.sharpe_ratio)} (stop ${rows[0]?.stopAtrMult}, tp ${rows[0]?.tpAtrMult}, rsiMin ${rows[0]?.rsiEntryMin}, conf ${rows[0]?.regimeMinConfidence})`);
  console.log(`report: ${file}`);
}

async function main() {
  const args = parseArgs();
  const pairs = args.pairs ?? config.pairs;
  const endMs = Date.now();
  const startMs = endMs - args.days * 86_400_000;

  console.log(`Backtest: ${pairs.join(', ')} | ${args.days} days | regime: ${args.mockRegime ? 'mock (canned bullish)' : 'claude (budget-capped)'}`);
  const history = {};
  for (const pair of pairs) {
    history[pair] = await getKlinesRange(pair, '1h', startMs, endMs);
    console.log(`[${pair}] ${history[pair].length} hourly candles loaded`);
    if (history[pair].length <= WARMUP) {
      console.error(`[${pair}] not enough history (need > ${WARMUP} candles)`);
      process.exit(1);
    }
  }

  if (args.gridSearch) {
    await gridSearch({ history, days: args.days, pairs });
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const dbPath = path.join(config.rootDir, 'data', `backtest_${stamp}.db`);
  await replay({ history, days: args.days, pairs, mockRegime: args.mockRegime, dbPath, quiet: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('backtest failed:', err);
    process.exitCode = 1;
  });
}
