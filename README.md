# TradePilot

A hybrid AI crypto **paper-trading** agent.

- An **AI layer** (Claude via the Anthropic API) makes slow, high-level calls: market regime (bullish / bearish / chop), a confidence score, and whether trading should be allowed at all.
- A **deterministic rule layer** (plain code, no AI) makes every fast and dangerous decision: position sizing, entries, stop-losses, take-profits, drawdown halts, and order execution.
- **The AI never places orders.** It only outputs a structured opinion. The rule engine decides everything else.

Market data is **real** (Binance public REST API, no key needed). All fills are **simulated** locally against a virtual $1,000 portfolio, with slippage and taker fees charged against you so the results stay honest.

## This is a paper-trading research tool

TradePilot exists to study how an AI regime classifier interacts with a deterministic risk engine. It is **not** financial advice and **not** a trading product:

- There is **no code path that places a real order**. The executor interface has exactly one implementation, `PaperExecutor`, which simulates fills in SQLite. A live executor is intentionally not implemented.
- No exchange API keys exist anywhere in this project — market data comes from Binance's public, unauthenticated endpoints.
- Simulated results — even over real market data — **do not guarantee live profitability**. Paper fills ignore order-book depth, partial fills, exchange outages, and the behavioral reality of risking actual money.

## Architecture

```
                 ┌──────────────────────────────────────────────────────┐
                 │                      index.js                        │
                 │   orchestration loop: integrity check, DB backup,    │
                 │   liquidity filter, load-all → decide-all, alerts    │
                 └──────┬───────────────────┬──────────────────┬────────┘
                        │                   │                  │
              ┌─────────▼────────┐ ┌────────▼────────┐ ┌───────▼────────┐
              │ data/binance.js  │ │  indicators.js  │ │ report/daily.js│
              │ 1h/4h/1d klines, │ │ RSI EMA ATR vol │ │ HTML + console │
              │ ticker, funding  │ │ corr percentile │ │ regime accuracy│
              └─────────┬────────┘ └────────┬────────┘ └────────────────┘
                        │                   │
                        │   compact JSON summary + portfolio context
                        │                   │
                        │          ┌────────▼─────────────────────────┐
                        │          │ AI LAYER (slow, every 4h/pair)   │
                        │          │  ai/sentiment.js → Grok reads X  │
                        │          │  ai/regime.js → Claude decides   │
                        │          │  ai/budget.js → per-provider cap │
                        │          │  optional Groq yes/no pre-filter │
                        │          └────────┬─────────────────────────┘
                        │                   │  opinion only — no orders
              ┌─────────▼───────────────────▼─────────────────────────┐
              │ RULE LAYER (deterministic, every cycle)               │
              │  engine/rules.js   entry filters (volume, MTF, RSI    │
              │                    zones, correlation, weekend),      │
              │                    trailing/partial exits, emergency  │
              │                    exit, regime sizing, vol targeting │
              │  engine/portfolio.js  cash, equity, P&L, vol scale    │
              │  engine/executor.js   PaperExecutor (default)         │
              │  engine/testnetExecutor.js  Binance Spot Testnet      │
              └─────────────────────────┬─────────────────────────────┘
                                        │
                              ┌─────────▼─────────┐     ┌──────────────────┐
                              │   db.js (SQLite)  │◀────│ src/backtest.js  │
                              │ trades, regimes,  │     │ replay + grid    │
                              │ sentiment, equity,│     ├──────────────────┤
                              │ budget, orders,   │     │ src/montecarlo.js│
                              │ regime_accuracy   │     │ resampled risk   │
                              └─────────┬─────────┘     ├──────────────────┤
                                        │               │ src/alert.js     │
                                        └──────────────▶│ Telegram (opt-in)│
                                                        └──────────────────┘
```

## Setup

Requires Node.js ≥ 18.17 (built-in `fetch`).

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm test                    # 65 unit tests
npm run cycle               # one single pass
npm start                   # continuous loop, one cycle every 15 minutes
npm run report              # writes reports/YYYY-MM-DD.html
npm run backtest -- --days 90 --mock-regime        # historical replay
npm run backtest -- --grid-search --mock-regime    # parameter sweep
npm run monte-carlo                                 # risk-of-ruin analysis
```

To try it with zero network calls and zero AI spend:

```bash
TRADEPILOT_MOCK=1 npm run cycle
```

Mock mode uses deterministic synthetic candles and a canned bullish regime, and writes to a separate database (`data/tradepilot.mock.db`).

Every tunable (pairs, cadences, risk %, budget cap, model, fees, slippage) lives in [src/config.js](src/config.js) and can be overridden via `.env` — see [.env.example](.env.example) for the full list.

## How the trading rules work

The rule engine runs every 15 minutes and is the only component that opens or closes positions. Long-only spot, v1.

**Entry — all must pass** (each new filter has a config flag; disabled = original behavior):

| Check | Condition |
|---|---|
| AI regime | `bullish`, `trade_allowed: true`, confidence ≥ 60 |
| Trend filter | price above EMA(50) on 4h |
| Daily trend filter | price above EMA(50) on the daily timeframe |
| Momentum filter | RSI(14) on 1h inside the dynamic band (see below) |
| Volume confirmation | current 1h volume ≥ 110% of its 20-period average |
| Correlation filter | 20-period 1h-return correlation with every open pair < 0.85 |
| Sentiment caution | if Grok says `very_bullish` at intensity > 90: RSI ≤ 60 and confidence ≥ 75 |
| Weekend filter | (opt-in) not between Fri 20:00 and Sun 20:00 UTC |
| Slots | no open position in the pair, max 2 concurrent positions |
| Cooldown | no stop-out on this pair in the last 4 hours |
| Halt | daily drawdown halt not active |

**Dynamic RSI zones:** the RSI band adapts to the ATR percentile over the trailing 14 days of hourly ATRs — calm tape (< 40th pct) narrows to [48, 65], volatile tape (> 60th pct) widens to [42, 75], otherwise the standard [45, 70].

**Risk (hard-coded, never AI-controlled):** risk 1% of equity per trade — or 1.5% with a 30% notional cap when the regime is bullish at confidence ≥ 80 (regime-dependent sizing); position size = risk ÷ stop distance; stop = 1.5 × ATR(14, 1h) below entry; take-profit = 2.5 × ATR above. **Volatility targeting** scales all new positions down proportionally when realized portfolio volatility (20-period hourly equity returns, annualized) exceeds 40% — it never scales up.

**Position management, every cycle:**
- **Trailing stop:** at +1.5R the stop moves to breakeven (entry price).
- **Partial exit:** at +2.0R, 50% of the position is closed at market; the remainder keeps the breakeven stop and targets +4.0R.
- **Emergency exit:** any position trading ≥ 5% below entry is closed immediately (`emergency_exit`), regardless of stop distance or regime.
- **Standard exits:** stop hit, take-profit hit, or the AI flips to `bearish` with confidence ≥ 70.

**Daily drawdown halt:** if equity drops 3% from the day's opening equity, nothing is force-closed, but all new entries are blocked until the next UTC day (`RISK_HALT` event logged).

**Paper fills:** every fill pays 0.05% slippage against you plus a 0.1% taker fee per side — so a round trip costs ~0.3% before the market moves at all.

## How the AI budget cap works

1. Claude is called at most once every 4 hours per pair. Between calls the last stored regime is reused as-is.
2. If `GROQ_API_KEY` is set, a free Groq Llama call first answers "has anything materially changed? yes/no". On "no", the Claude call is skipped (logged as `GROQ_SKIPPED`) — unless the last Claude call is older than 8 hours.
3. Before each Claude call, the budget gate estimates the worst-case cost (~2,000 input + 300 output tokens at Sonnet pricing: $3 / $15 per MTok ≈ **$0.0105 per call**). If today's recorded spend plus that estimate would exceed `AI_DAILY_BUDGET_USD` (default **$0.50/day**), the call is skipped, the event `BUDGET_SKIPPED` is logged, and the last regime is reused with its confidence decayed by 20 points — so a stale opinion gradually loses the power to trigger entries.
4. After a real call, the **actual** token counts from the API response are converted to dollars and persisted in the `ai_budget` table, one row per UTC day.

If Claude's output fails to parse or validate, the result is treated as `{"regime":"chop","confidence":0,"trade_allowed":false}` — i.e. *don't trade* — and the failure is logged.

## The Grok X-sentiment layer (optional)

**Grok reads the crowd, Claude makes the call, rules manage the money.**

If `XAI_API_KEY` is set, [src/ai/sentiment.js](src/ai/sentiment.js) asks Grok (xAI, with Live Search over X) for the crowd's read on each pair — sentiment label, intensity 0–100, key narratives, notable events — immediately before each Claude regime call, on the same 4-hour cadence. The block is added to the JSON summary Claude receives, with one standing instruction: extreme euphoria (`very_bullish`, intensity > 85) is a caution signal, not a buy signal, and extreme panic is a possible contrarian datapoint. The technicals still lead.

Sentiment is an input, never a blocker: it has its own daily budget cap (`GROK_DAILY_BUDGET_USD`, default $0.30/day — on cap hit the last sentiment is reused with intensity decayed by 30 and `GROK_BUDGET_SKIPPED` logged), its own `sentiment_calls` table, and every failure path degrades to neutral (`SENTIMENT_FAILED` logged). Without the xAI key the layer is skipped entirely and the system runs exactly as it does on the Anthropic key alone. Grok never touches position sizing, stops, or execution.

Note: the xAI model name, Live Search parameters, and per-source search pricing change over time — verify the values in `config.js` against the current [xAI docs](https://docs.x.ai).

## How to read the reports

`npm run report` writes `reports/YYYY-MM-DD.html` containing:

- **Equity curve** — inline SVG from the hourly `equity_snapshots` table.
- **Summary** — equity, cash, win rate, profit factor (gross wins ÷ gross losses), total P&L, max drawdown, and total AI spend.
- **Open positions / closed trades** — entries, exits, stops, take-profits, fees-inclusive P&L, and the exit reason (`stop`, `tp`, `regime_flip`).
- **Last 10 regime calls** — timestamp, regime, confidence, cost, and Claude's two-sentence reasoning.

The console prints a one-screen summary (equity, open positions, today's P&L, today's AI spend) at the end of every cycle.

Everything in the report is derived from SQLite — every AI decision and every rule decision is explainable from the database alone (`regime_calls`, `trades`, `equity_snapshots`, `ai_budget`, `events`).

## Backtester

`npm run backtest -- --days 90 --pair BTCUSDT --mock-regime` replays historical 1h Binance candles through the **same** `indicators.js` + `rules.js` code the live loop uses, with the PaperExecutor fill model, into a separate timestamped DB (`data/backtest_*.db`). Indicator arrays are computed once over the full series — RSI/EMA/ATR are recursive, so there is no lookahead. It prints and stores total/annualized return, max drawdown, Sharpe, Sortino, win rate, profit factor, expectancy, average holding time, consecutive win/loss streaks, and `RISK_HALT` counts. `--mock-regime` uses a canned bullish regime (recommended — without it, Claude is called on the sim-time cadence and today's real budget cap applies). `--grid-search` sweeps stop ATR × TP ATR × RSI floor × confidence threshold (144 combos) and writes a Sharpe-ranked table to `reports/grid_search_*.html` — **best parameters are reported, never auto-applied**.

## Monte Carlo risk analysis

`npm run monte-carlo` resamples the closed-trade P&L distribution (10,000 simulations of N random trade sequences) and reports the median final equity, the 5th-percentile outcome (risk-of-ruin boundary), the probability of a ≥20% drawdown, and the probability of doubling — with an SVG distribution chart in `reports/montecarlo_*.html`. Point it at a backtest DB with `DB_PATH=data/backtest_<stamp>.db npm run monte-carlo`.

## Regime accuracy tracking

Every trade stores the regime and confidence that were active at entry; on close, the realized return and holding time land in the `regime_accuracy` table. The daily report shows, per regime label, how often that opinion produced a profitable trade — so you can see whether Claude's `bullish` calls actually pay before trusting higher confidence levels.

## Telegram alerts (optional)

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, [src/alert.js](src/alert.js) pushes notifications for trade opens/closes (with P&L), partial exits, emergency exits, `RISK_HALT`, `REGIME_PARSE_FAILURE`, a third consecutive `BUDGET_SKIPPED`, and a once-daily equity summary. Alerting is strictly best-effort: unset keys make it a silent no-op, and no failure can block or crash the cycle.

## Robustness

At startup the SQLite database must pass `PRAGMA integrity_check` or the process exits before any trading activity; each cycle starts by refreshing an on-disk backup (`tradepilot.db.bak`). Pairs whose 24h quote volume is below `LIQUIDITY_MIN_VOLUME_24H` (default $50M) are excluded for the run (`PAIR_EXCLUDED` logged) — the default list is now BTC, ETH, SOL, BNB, XRP. Claude's prompt requests step-by-step reasoning in a `<thinking>` tag followed by strict JSON (integer confidence, non-empty reasoning); anything that fails validation degrades to the no-trade `chop` fallback with a `REGIME_PARSE_FAILURE` event. The regime prompt is also enriched with the outcomes of its own last five calls, portfolio drawdown from peak, an approximate BTC volume dominance, and the trailing 7-day win rate / profit factor.

## Testnet mode

The bridge between paper simulation and reality: `EXECUTOR=testnet` places **real market orders on the Binance Spot Testnet** — a real order book with **fake funds that reset periodically**.

1. Create testnet API keys at [testnet.binance.vision](https://testnet.binance.vision) (log in with GitHub, "Generate HMAC_SHA256 Key"). These keys do not work on mainnet — an extra safety property.
2. Put them in `.env` as `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` and set `EXECUTOR=testnet`.
3. Run as usual. Startup prints `EXECUTOR: BINANCE SPOT TESTNET — no real funds`.

What changes vs. paper mode: orders are signed (HMAC-SHA256) and placed as MARKET orders; quantities are floored to the exchange's `LOT_SIZE` step (below-minimum orders are skipped, never rounded up); the `trades` table records the **actual** average fill price and fees from the exchange response plus the Binance order id; every raw request/response lands in the `orders` table; and each cycle starts by reconciling local cash against `/api/v3/account` (mismatch ⇒ `STATE_MISMATCH` logged and entries blocked for that cycle). Stops and take-profits are still enforced by the rule engine every cycle — no native exchange stop orders, one source of truth. The report's "fill vs signal" column lets you validate paper mode's slippage assumptions against reality.

The testnet base URL is **hard-coded** in [src/engine/testnetExecutor.js](src/engine/testnetExecutor.js) and asserted at startup — it cannot be redirected to mainnet via config or env. **Mainnet trading is intentionally not implemented anywhere in this codebase.**

## Running on GitHub Actions

[.github/workflows/tradepilot.yml](.github/workflows/tradepilot.yml) runs `npm run cycle` every 15 minutes in a **private** repo:

1. Checks out the repo (which contains the committed SQLite DB at `data/tradepilot.db`).
2. Runs one cycle with `ANTHROPIC_API_KEY` (and optional `GROQ_API_KEY`) from Actions secrets.
3. Regenerates the daily report and commits the updated DB + report back to the repo.

A `concurrency` group guarantees runs never overlap. Note that scheduled workflows on GitHub can drift a few minutes — the AI cadence and budget cap are enforced internally, so drift only affects rule-engine timing, never spend.

## Security & hygiene

- `.env` and `node_modules` are gitignored; `.env.example` contains placeholders only.
- No real exchange API keys anywhere — market data is public and unauthenticated.
- The only secrets are AI provider keys — `ANTHROPIC_API_KEY` plus the optional `XAI_API_KEY` and `GROQ_API_KEY` — all read from the environment, never logged or persisted.

## Project layout

```
src/
  index.js            entry point, orchestration loop
  config.js           all tunables (env-overridable)
  data/binance.js     public market data client (cache + backoff + mock mode)
  indicators.js       RSI, EMA, ATR, volatility — implemented by hand
  ai/regime.js        Claude regime calls, defensive parsing, Groq pre-filter
  ai/sentiment.js     Grok (xAI) X-sentiment layer (optional, never a blocker)
  ai/budget.js        daily AI spend tracker per provider (SQLite)
  engine/rules.js     deterministic strategy + risk rules
  engine/portfolio.js virtual portfolio, P&L
  engine/executor.js  PaperExecutor (slippage + fees), the default
  engine/testnetExecutor.js  Binance Spot TESTNET executor (frozen testnet URL);
                      no live/mainnet executor exists
  report/daily.js     daily HTML + console report
  backtest.js         historical replay + grid search (separate DBs)
  montecarlo.js       resampled P&L risk analysis
  alert.js            Telegram alerts (optional, never blocking)
  db.js               SQLite schema, migrations, helpers
test/                 node:test suites (no extra deps)
```
