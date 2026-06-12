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
                 │        orchestration loop (every 15 minutes)         │
                 └──────┬───────────────────┬──────────────────┬────────┘
                        │                   │                  │
              ┌─────────▼────────┐ ┌────────▼────────┐ ┌───────▼────────┐
              │ data/binance.js  │ │  indicators.js  │ │ report/daily.js│
              │ klines, ticker,  │ │ RSI EMA ATR vol │ │ HTML + console │
              │ funding (public) │ │  (hand-rolled)  │ └────────────────┘
              └─────────┬────────┘ └────────┬────────┘
                        │                   │
                        │     compact JSON summary
                        │                   │
                        │          ┌────────▼─────────────────────────┐
                        │          │ AI LAYER (slow, every 4h/pair)   │
                        │          │  ai/regime.js → Claude API       │
                        │          │  ai/budget.js → $0.50/day cap    │
                        │          │  optional Groq yes/no pre-filter │
                        │          │  output: {regime, confidence,    │
                        │          │           trade_allowed, reason} │
                        │          └────────┬─────────────────────────┘
                        │                   │  opinion only — no orders
              ┌─────────▼───────────────────▼─────────────────────────┐
              │ RULE LAYER (deterministic, every cycle)               │
              │  engine/rules.js     entries, exits, sizing, halts    │
              │  engine/portfolio.js cash, equity, P&L                │
              │  engine/executor.js  PaperExecutor (slippage + fees)  │
              └─────────────────────────┬─────────────────────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │   db.js (SQLite)  │
                              │ trades, regimes,  │
                              │ equity, budget,   │
                              │ events            │
                              └───────────────────┘
```

## Setup

Requires Node.js ≥ 18.17 (built-in `fetch`).

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm test                    # 20 unit tests (indicators, sizing, exits, parsing, budget)
npm run cycle               # one single pass
npm start                   # continuous loop, one cycle every 15 minutes
npm run report              # writes reports/YYYY-MM-DD.html
```

To try it with zero network calls and zero AI spend:

```bash
TRADEPILOT_MOCK=1 npm run cycle
```

Mock mode uses deterministic synthetic candles and a canned bullish regime, and writes to a separate database (`data/tradepilot.mock.db`).

Every tunable (pairs, cadences, risk %, budget cap, model, fees, slippage) lives in [src/config.js](src/config.js) and can be overridden via `.env` — see [.env.example](.env.example) for the full list.

## How the trading rules work

The rule engine runs every 15 minutes and is the only component that opens or closes positions. Long-only spot, v1.

**Entry — all must pass:**

| Check | Condition |
|---|---|
| AI regime | `bullish`, `trade_allowed: true`, confidence ≥ 60 |
| Trend filter | price above EMA(50) on 4h |
| Momentum filter | RSI(14) on 1h between 45 and 70 |
| Slots | no open position in the pair, max 2 concurrent positions |
| Cooldown | no stop-out on this pair in the last 4 hours |
| Halt | daily drawdown halt not active |

**Risk (hard-coded, never AI-controlled):** risk 1% of equity per trade; position size = risk ÷ stop distance; stop = 1.5 × ATR(14, 1h) below entry; take-profit = 2.5 × ATR above (≈1.67 R:R); position notional capped at 25% of equity.

**Exits, checked every cycle:** stop hit, take-profit hit, or the AI flips to `bearish` with confidence ≥ 70.

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
  db.js               SQLite schema and helpers
test/                 node:test suites (no extra deps)
```
