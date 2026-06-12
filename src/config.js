// All tunables in one place. Every value can be overridden via .env / environment.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const mock = process.env.TRADEPILOT_MOCK === '1';

export const config = {
  // --- general ---
  mock, // mock mode: synthetic market data + canned AI regime, zero network calls
  rootDir: ROOT,
  dbPath: process.env.DB_PATH
    ? path.resolve(ROOT, process.env.DB_PATH)
    : path.join(ROOT, 'data', mock ? 'tradepilot.mock.db' : 'tradepilot.db'),
  reportsDir: path.join(ROOT, 'reports'),

  // --- market data ---
  pairs: list(process.env.PAIRS, ['BTCUSDT', 'ETHUSDT']),
  binanceBase: process.env.BINANCE_BASE || 'https://api.binance.com',
  binanceFapiBase: process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com',
  klineLimit: num(process.env.KLINE_LIMIT, 200),
  minPollMs: num(process.env.MIN_POLL_MS, 60_000), // never hit the same endpoint faster than this

  // --- loop cadence ---
  cycleMinutes: num(process.env.CYCLE_MINUTES, 15),
  aiCadenceHours: num(process.env.AI_CADENCE_HOURS, 4),
  aiMaxStaleHours: num(process.env.AI_MAX_STALE_HOURS, 8), // Groq pre-filter can defer Claude up to this age

  // --- AI layer ---
  aiModel: process.env.AI_MODEL || 'claude-sonnet-4-6',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBase: process.env.ANTHROPIC_BASE || 'https://api.anthropic.com',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  aiDailyBudgetUsd: num(process.env.AI_DAILY_BUDGET_USD, 0.5),
  aiMaxOutputTokens: num(process.env.AI_MAX_OUTPUT_TOKENS, 300),
  // claude-sonnet-4-6 pricing (USD per million tokens)
  pricing: {
    inputPerMTok: num(process.env.AI_PRICE_INPUT_MTOK, 3.0),
    outputPerMTok: num(process.env.AI_PRICE_OUTPUT_MTOK, 15.0),
  },
  // Worst-case pre-call estimate used by the budget gate before we know real usage.
  estInputTokens: num(process.env.AI_EST_INPUT_TOKENS, 2000),
  estOutputTokens: num(process.env.AI_EST_OUTPUT_TOKENS, 300),
  budgetDecayPoints: num(process.env.BUDGET_DECAY_POINTS, 20),

  // --- Grok (xAI) X-sentiment layer (optional; system runs fine without it) ---
  xaiApiKey: process.env.XAI_API_KEY || '',
  xaiBase: process.env.XAI_BASE || 'https://api.x.ai',
  // NOTE: verify the current model name and Live Search parameter shape in the
  // xAI docs (https://docs.x.ai) — both change between releases.
  grokModel: process.env.GROK_MODEL || 'grok-4-3',
  grokSearchParameters: {
    mode: 'on',
    sources: [{ type: 'x' }],
    max_search_results: 5,
  },
  grokDailyBudgetUsd: num(process.env.GROK_DAILY_BUDGET_USD, 1.0),
  grokMaxOutputTokens: num(process.env.GROK_MAX_OUTPUT_TOKENS, 300),
  // xAI pricing constants (USD). Verify against current xAI pricing — token
  // rates AND the per-source Live Search charge are billed separately.
  grokPricing: {
    inputPerMTok: num(process.env.GROK_PRICE_INPUT_MTOK, 3.0),
    outputPerMTok: num(process.env.GROK_PRICE_OUTPUT_MTOK, 15.0),
  },
  xaiSearchCostPerSource: num(process.env.XAI_SEARCH_COST_PER_SOURCE, 0.025), // $25 / 1k sources
  grokEstInputTokens: num(process.env.GROK_EST_INPUT_TOKENS, 600),
  grokEstOutputTokens: num(process.env.GROK_EST_OUTPUT_TOKENS, 250),
  grokEstSearchSources: num(process.env.GROK_EST_SEARCH_SOURCES, 5),
  sentimentDecayPoints: num(process.env.SENTIMENT_DECAY_POINTS, 30),

  // --- risk rules (deterministic; never AI-controlled) ---
  startBalance: num(process.env.START_BALANCE, 1000),
  riskPerTrade: num(process.env.RISK_PER_TRADE, 0.01),
  stopAtrMult: num(process.env.STOP_ATR_MULT, 1.5),
  tpAtrMult: num(process.env.TP_ATR_MULT, 2.5),
  maxPositions: num(process.env.MAX_POSITIONS, 2),
  maxNotionalPct: num(process.env.MAX_NOTIONAL_PCT, 0.25),
  dailyDrawdownHalt: num(process.env.DAILY_DRAWDOWN_HALT, 0.03),
  cooldownHours: num(process.env.COOLDOWN_HOURS, 4),
  regimeMinConfidence: num(process.env.REGIME_MIN_CONFIDENCE, 60),
  regimeFlipConfidence: num(process.env.REGIME_FLIP_CONFIDENCE, 70),
  rsiEntryMin: num(process.env.RSI_ENTRY_MIN, 45),
  rsiEntryMax: num(process.env.RSI_ENTRY_MAX, 70),

  // --- execution ---
  // 'paper' (default) or 'testnet'. The testnet base URL is intentionally NOT
  // configurable — it is a frozen constant in engine/testnetExecutor.js so this
  // executor can never be pointed at mainnet. No live executor exists.
  executor: (process.env.EXECUTOR || 'paper').toLowerCase(),
  binanceTestnetApiKey: process.env.BINANCE_TESTNET_API_KEY || '',
  binanceTestnetApiSecret: process.env.BINANCE_TESTNET_API_SECRET || '',

  // --- paper fill simulation ---
  slippage: num(process.env.SLIPPAGE, 0.0005), // 0.05% against you per fill
  takerFee: num(process.env.TAKER_FEE, 0.001), // 0.1% Binance spot taker fee per side
};

export default config;
