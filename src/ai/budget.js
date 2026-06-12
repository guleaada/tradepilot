// Daily AI spend tracker per provider, persisted in SQLite (table: ai_budget).
// Provider defaults to 'anthropic' so the original call sites are unchanged.
import { getDb } from '../db.js';
import { config } from '../config.js';

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function getDailySpend(db = getDb(), date = todayUtc(), provider = 'anthropic') {
  const row = db
    .prepare('SELECT spend FROM ai_budget WHERE date = ? AND provider = ?')
    .get(date, provider);
  return row ? row.spend : 0;
}

export function addSpend(usd, db = getDb(), date = todayUtc(), provider = 'anthropic') {
  db.prepare(
    `INSERT INTO ai_budget (date, provider, spend) VALUES (?, ?, ?)
     ON CONFLICT(date, provider) DO UPDATE SET spend = spend + excluded.spend`,
  ).run(date, provider, usd);
}

export function wouldExceedBudget(
  estCostUsd,
  capUsd = config.aiDailyBudgetUsd,
  db = getDb(),
  date = todayUtc(),
  provider = 'anthropic',
) {
  return getDailySpend(db, date, provider) + estCostUsd > capUsd;
}

export function costFromUsage(inputTokens, outputTokens, pricing = config.pricing) {
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function estimateCallCost(cfg = config) {
  return costFromUsage(cfg.estInputTokens, cfg.estOutputTokens, cfg.pricing);
}

// xAI bills Live Search sources separately from tokens.
export function grokCostFromUsage(inputTokens, outputTokens, searchSources, cfg = config) {
  return (
    costFromUsage(inputTokens, outputTokens, cfg.grokPricing) +
    searchSources * cfg.xaiSearchCostPerSource
  );
}

export function estimateGrokCallCost(cfg = config) {
  return grokCostFromUsage(cfg.grokEstInputTokens, cfg.grokEstOutputTokens, cfg.grokEstSearchSources, cfg);
}
