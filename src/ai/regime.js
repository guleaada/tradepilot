// Claude regime-call module. The AI layer only emits an opinion:
//   { regime, confidence, trade_allowed, reasoning }
// It NEVER sizes positions or places orders — that is the rule engine's job.
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db.js';
import {
  addSpend,
  costFromUsage,
  estimateCallCost,
  warnIfBudgetMisconfigured,
  wouldExceedBudget,
} from './budget.js';

export const FALLBACK_REGIME = Object.freeze({
  regime: 'chop',
  confidence: 0,
  trade_allowed: false,
  reasoning: 'fallback: AI output missing or invalid',
});

const VALID_REGIMES = new Set(['bullish', 'bearish', 'chop']);

const SYSTEM_PROMPT = [
  'You are the market-regime analyst for a crypto paper-trading research system.',
  'You receive a compact JSON market summary for one trading pair.',
  'Classify the current regime and decide whether the deterministic rule engine should be allowed to trade at all.',
  'The summary may include an x_sentiment block (crowd sentiment from X).',
  'Treat extreme crowd euphoria (very_bullish with intensity > 85) as a caution signal, not a buy signal;',
  'likewise treat extreme panic as a possible contrarian datapoint.',
  'Sentiment is one input among several — the technicals still lead.',
  'You do not size positions, pick entries, or place orders.',
  'Respond with ONLY raw JSON, no markdown, no code fences, exactly this schema:',
  '{"regime":"bullish"|"bearish"|"chop","confidence":0-100,"trade_allowed":true|false,"reasoning":"max 2 sentences"}',
].join(' ');

// Parse defensively: strip code fences, extract the outermost JSON object,
// validate the schema. Returns null on any failure.
export function parseRegimeResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let body = text.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    body = body.slice(start, end + 1);
  }
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!VALID_REGIMES.has(obj.regime)) return null;
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) return null;
  if (typeof obj.trade_allowed !== 'boolean') return null;
  return {
    regime: obj.regime,
    confidence: Math.max(0, Math.min(100, confidence)),
    trade_allowed: obj.trade_allowed,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 500) : '',
  };
}

// Compact market summary fed to Claude. Kept well under ~1,500 tokens.
// `sentiment` is the latest Grok X-sentiment block (or null when the xAI
// layer is disabled).
export function buildMarketSummary(pair, market, recentCalls = [], recentTrades = [], sentiment = null) {
  const r = (v, d = 2) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
  return {
    pair,
    as_of: nowIso(),
    price: r(market.price, 2),
    ohlc_1h_last5: market.last5,
    rsi14_1h: r(market.rsi1h),
    ema_1h: { e20: r(market.ema20_1h), e50: r(market.ema50_1h), e200: r(market.ema200_1h) },
    ema_4h: { e20: r(market.ema20_4h), e50: r(market.ema50_4h), e200: r(market.ema200_4h) },
    price_vs_ema50_4h: market.ema50_4h ? r((market.price / market.ema50_4h - 1) * 100, 2) : null,
    atr14_1h: r(market.atr1h, 4),
    atr_pct_of_price: market.atr1h ? r((market.atr1h / market.price) * 100, 3) : null,
    volatility_20: market.vol20 === null ? null : r(market.vol20 * 100, 3),
    change_24h_pct: r(market.change24hPct),
    volume_24h: r(market.volume24h, 0),
    funding_rate: market.fundingRate === null
      ? 'unavailable (futures endpoint unreachable)'
      : market.fundingRate,
    x_sentiment: sentiment ?? { sentiment: 'unavailable' },
    last_regime_calls: recentCalls.map((c) => ({
      ts: c.ts,
      regime: c.regime,
      confidence: c.confidence,
      trade_allowed: !!c.trade_allowed,
    })),
    recent_closed_trades: recentTrades.map((t) => ({
      exit_time: t.exit_time,
      pnl: r(t.pnl),
      exit_reason: t.exit_reason,
    })),
  };
}

async function callClaude(summary) {
  const res = await fetch(`${config.anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.aiModel,
      max_tokens: config.aiMaxOutputTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(summary) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: data.usage || { input_tokens: 0, output_tokens: 0 } };
}

// Optional free pre-filter: ask Groq whether anything materially changed.
// Returns true ("call Claude") on any doubt or failure.
async function groqSaysChanged(summary, lastSummaryJson) {
  if (!config.groqApiKey || !lastSummaryJson) return true;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: config.groqModel,
        max_tokens: 5,
        messages: [
          {
            role: 'user',
            content:
              'Compare these two crypto market summaries. Has anything materially changed ' +
              '(trend direction, RSI zone, volatility, funding)? Answer with exactly one word: yes or no.\n' +
              `PREVIOUS: ${lastSummaryJson}\nCURRENT: ${JSON.stringify(summary)}`,
          },
        ],
      }),
    });
    if (!res.ok) return true;
    const data = await res.json();
    const answer = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    return !answer.startsWith('no');
  } catch {
    return true;
  }
}

function rowToRegime(row) {
  return {
    regime: row.regime,
    confidence: row.confidence,
    trade_allowed: !!row.trade_allowed,
    reasoning: row.reasoning || '',
  };
}

function decayed(row, points = config.budgetDecayPoints) {
  const base = rowToRegime(row);
  return { ...base, confidence: Math.max(0, base.confidence - points) };
}

function recordCall(db, pair, regime, summary, usage, estCost, source, rawText) {
  db.prepare(
    `INSERT INTO regime_calls
       (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json,
        input_tokens, output_tokens, est_cost, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    pair,
    regime.regime,
    regime.confidence,
    regime.trade_allowed ? 1 : 0,
    regime.reasoning,
    rawText ?? JSON.stringify(regime),
    JSON.stringify(summary),
    usage.input_tokens || 0,
    usage.output_tokens || 0,
    estCost,
    source,
  );
}

// Main entry: returns the regime the rule engine should use this cycle.
// Respects AI cadence, the Groq pre-filter, and the hard daily budget cap.
export async function getRegime(pair, summary, db = getDb()) {
  if (config.mock) {
    const mock = {
      regime: 'bullish',
      confidence: 72,
      trade_allowed: true,
      reasoning: 'Mock regime: synthetic uptrend with healthy momentum.',
    };
    recordCall(db, pair, mock, summary, { input_tokens: 0, output_tokens: 0 }, 0, 'mock', null);
    return mock;
  }

  const lastCall = db
    .prepare('SELECT * FROM regime_calls WHERE pair = ? ORDER BY id DESC LIMIT 1')
    .get(pair);
  const ageHours = lastCall ? (Date.now() - Date.parse(lastCall.ts)) / 3_600_000 : Infinity;

  // Cadence: never call Claude more often than every aiCadenceHours per pair.
  if (lastCall && ageHours < config.aiCadenceHours) {
    return rowToRegime(lastCall);
  }

  // Groq pre-filter: skip Claude if nothing changed, unless the last call is
  // older than aiMaxStaleHours.
  if (lastCall && ageHours < config.aiMaxStaleHours) {
    const changed = await groqSaysChanged(summary, lastCall.summary_json);
    if (!changed) {
      logEvent('GROQ_SKIPPED', { pair, ageHours: Number(ageHours.toFixed(2)) }, db);
      return rowToRegime(lastCall);
    }
  }

  // Hard daily budget cap.
  const estCost = estimateCallCost();
  warnIfBudgetMisconfigured(estCost, config.aiDailyBudgetUsd, 'anthropic', db);
  if (wouldExceedBudget(estCost, config.aiDailyBudgetUsd, db)) {
    logEvent('BUDGET_SKIPPED', { pair, estCost }, db);
    return lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME };
  }

  if (!config.anthropicApiKey) {
    logEvent('AI_ERROR', { pair, error: 'ANTHROPIC_API_KEY not set' }, db);
    return lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME };
  }

  try {
    const { text, usage } = await callClaude(summary);
    const cost = costFromUsage(usage.input_tokens || 0, usage.output_tokens || 0);
    addSpend(cost, db);

    const parsed = parseRegimeResponse(text);
    if (!parsed) {
      logEvent('AI_PARSE_FAIL', { pair, raw: String(text).slice(0, 300) }, db);
      const fb = { ...FALLBACK_REGIME };
      recordCall(db, pair, fb, summary, usage, cost, 'claude_parse_fail', text);
      return fb;
    }
    recordCall(db, pair, parsed, summary, usage, cost, 'claude', text);
    return parsed;
  } catch (err) {
    logEvent('AI_ERROR', { pair, error: String(err).slice(0, 300) }, db);
    return lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME };
  }
}
