// Grok (xAI) X-sentiment layer. Reads crowd sentiment from X via xAI's Live
// Search and hands a structured opinion to the Claude regime call.
//
// Sentiment is an INPUT, never a blocker: every failure path returns a usable
// object and the system runs fine with no XAI_API_KEY at all. Grok never
// influences position sizing, stops, or execution — it only colors the
// summary Claude sees.
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db.js';
import {
  addSpend,
  estimateGrokCallCost,
  grokCostFromUsage,
  warnIfBudgetMisconfigured,
  wouldExceedBudget,
} from './budget.js';

export const FALLBACK_SENTIMENT = Object.freeze({
  sentiment: 'neutral',
  intensity: 0,
  key_narratives: [],
  notable_events: null,
});

// Returned when XAI_API_KEY is missing — the module is skipped entirely.
export const UNAVAILABLE_SENTIMENT = Object.freeze({
  sentiment: 'unavailable',
  intensity: 0,
  key_narratives: [],
  notable_events: null,
});

const VALID_SENTIMENTS = new Set(['very_bearish', 'bearish', 'neutral', 'bullish', 'very_bullish']);

// Defensive parsing, same approach as the Claude regime handling: strip code
// fences, extract the outermost JSON object, validate the schema strictly.
// Returns null on any failure.
export function parseSentimentResponse(text) {
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
  if (!VALID_SENTIMENTS.has(obj.sentiment)) return null;
  const intensity = Number(obj.intensity);
  if (!Number.isFinite(intensity)) return null;
  if (!Array.isArray(obj.key_narratives)) return null;
  if (obj.notable_events !== null && typeof obj.notable_events !== 'string') return null;
  return {
    sentiment: obj.sentiment,
    intensity: Math.max(0, Math.min(100, intensity)),
    key_narratives: obj.key_narratives
      .filter((n) => typeof n === 'string')
      .slice(0, 3)
      .map((n) => n.slice(0, 120)),
    notable_events: obj.notable_events === null ? null : obj.notable_events.slice(0, 300),
  };
}

function assetName(pair) {
  return pair.replace(/USDT$|USDC$|BUSD$/, '');
}

async function callGrok(pair, cfg) {
  const res = await fetch(`${cfg.xaiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.xaiApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.grokModel,
      max_tokens: cfg.grokMaxOutputTokens,
      search_parameters: cfg.grokSearchParameters,
      messages: [
        {
          role: 'user',
          content:
            `Search X for the current sentiment on ${assetName(pair)} over the last 12 hours. ` +
            'Respond with ONLY raw JSON, no markdown: ' +
            '{"sentiment":"very_bearish"|"bearish"|"neutral"|"bullish"|"very_bullish",' +
            '"intensity":0-100,"key_narratives":["max 3 short phrases"],' +
            '"notable_events":"one sentence or null"}',
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`xAI API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage || {};
  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    // xAI reports Live Search usage as num_sources_used — verify field name
    // against current xAI docs.
    searchSources: usage.num_sources_used ?? config.grokEstSearchSources,
  };
}

function rowToSentiment(row) {
  let narratives = [];
  try {
    narratives = JSON.parse(row.key_narratives || '[]');
  } catch { /* keep [] */ }
  return {
    sentiment: row.sentiment,
    intensity: row.intensity,
    key_narratives: narratives,
    notable_events: row.notable_events ?? null,
  };
}

function decayed(row, points = config.sentimentDecayPoints) {
  const base = rowToSentiment(row);
  return { ...base, intensity: Math.max(0, base.intensity - points) };
}

function recordCall(db, pair, sentiment, usage, estCost, source, rawText) {
  db.prepare(
    `INSERT INTO sentiment_calls
       (ts, pair, sentiment, intensity, key_narratives, notable_events, raw_json,
        input_tokens, output_tokens, search_sources, est_cost, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    pair,
    sentiment.sentiment,
    sentiment.intensity,
    JSON.stringify(sentiment.key_narratives),
    sentiment.notable_events,
    rawText ?? JSON.stringify(sentiment),
    usage.inputTokens || 0,
    usage.outputTokens || 0,
    usage.searchSources || 0,
    estCost,
    source,
  );
}

export function getLatestSentiment(pair, db = getDb()) {
  const row = db
    .prepare('SELECT * FROM sentiment_calls WHERE pair = ? ORDER BY id DESC LIMIT 1')
    .get(pair);
  return row ? { ...rowToSentiment(row), ts: row.ts } : null;
}

// Main entry: returns the sentiment block embedded in the Claude summary.
// Same cadence as the regime call (aiCadenceHours per pair), own budget cap.
export async function getSentiment(pair, db = getDb(), cfg = config) {
  if (cfg.mock) {
    const mock = {
      sentiment: 'bullish',
      intensity: 62,
      key_narratives: ['ETF inflows', 'halving chatter'],
      notable_events: 'Mock sentiment: synthetic crowd is mildly optimistic.',
    };
    recordCall(db, pair, mock, {}, 0, 'mock', null);
    return mock;
  }

  // No key: skip the module entirely. The system keeps running on the
  // Anthropic key alone, exactly as before this layer existed.
  if (!cfg.xaiApiKey) {
    return { ...UNAVAILABLE_SENTIMENT };
  }

  const lastRow = db
    .prepare('SELECT * FROM sentiment_calls WHERE pair = ? ORDER BY id DESC LIMIT 1')
    .get(pair);
  const ageHours = lastRow ? (Date.now() - Date.parse(lastRow.ts)) / 3_600_000 : Infinity;

  // Cadence: never call Grok more often than every aiCadenceHours per pair.
  if (lastRow && ageHours < cfg.aiCadenceHours) {
    return rowToSentiment(lastRow);
  }

  // Hard daily budget cap (separate from the Anthropic cap).
  const estCost = estimateGrokCallCost(cfg);
  warnIfBudgetMisconfigured(estCost, cfg.grokDailyBudgetUsd, 'grok', db);
  if (wouldExceedBudget(estCost, cfg.grokDailyBudgetUsd, db, undefined, 'grok')) {
    logEvent('GROK_BUDGET_SKIPPED', { pair, estCost }, db);
    return lastRow ? decayed(lastRow, cfg.sentimentDecayPoints) : { ...FALLBACK_SENTIMENT };
  }

  try {
    const usage = await callGrok(pair, cfg);
    const cost = grokCostFromUsage(usage.inputTokens, usage.outputTokens, usage.searchSources, cfg);
    addSpend(cost, db, undefined, 'grok');

    const parsed = parseSentimentResponse(usage.text);
    if (!parsed) {
      logEvent('SENTIMENT_FAILED', { pair, raw: String(usage.text).slice(0, 300) }, db);
      const fb = { ...FALLBACK_SENTIMENT };
      recordCall(db, pair, fb, usage, cost, 'grok_parse_fail', usage.text);
      return fb;
    }
    recordCall(db, pair, parsed, usage, cost, 'grok', usage.text);
    return parsed;
  } catch (err) {
    logEvent('SENTIMENT_FAILED', { pair, error: String(err).slice(0, 300) }, db);
    return lastRow ? decayed(lastRow, cfg.sentimentDecayPoints) : { ...FALLBACK_SENTIMENT };
  }
}
