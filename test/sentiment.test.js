import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { addSpend } from '../src/ai/budget.js';
import {
  FALLBACK_SENTIMENT,
  getSentiment,
  parseSentimentResponse,
  UNAVAILABLE_SENTIMENT,
} from '../src/ai/sentiment.js';

test('parses clean raw sentiment JSON', () => {
  const out = parseSentimentResponse(
    '{"sentiment":"bullish","intensity":70,"key_narratives":["ETF inflows","halving"],"notable_events":"Spot ETF saw record volume."}',
  );
  assert.deepEqual(out, {
    sentiment: 'bullish',
    intensity: 70,
    key_narratives: ['ETF inflows', 'halving'],
    notable_events: 'Spot ETF saw record volume.',
  });
});

test('strips markdown code fences and clamps intensity', () => {
  const out = parseSentimentResponse(
    '```json\n{"sentiment":"very_bullish","intensity":150,"key_narratives":[],"notable_events":null}\n```',
  );
  assert.equal(out.sentiment, 'very_bullish');
  assert.equal(out.intensity, 100);
  assert.equal(out.notable_events, null);
});

test('caps key_narratives at 3 entries', () => {
  const out = parseSentimentResponse(
    '{"sentiment":"neutral","intensity":50,"key_narratives":["a","b","c","d","e"],"notable_events":null}',
  );
  assert.deepEqual(out.key_narratives, ['a', 'b', 'c']);
});

test('rejects malformed and schema-invalid sentiment output', () => {
  assert.equal(parseSentimentResponse('not json'), null);
  assert.equal(parseSentimentResponse(''), null);
  assert.equal(parseSentimentResponse(null), null);
  assert.equal(parseSentimentResponse('{"sentiment":"mooning","intensity":50,"key_narratives":[],"notable_events":null}'), null);
  assert.equal(parseSentimentResponse('{"sentiment":"bullish","intensity":"high","key_narratives":[],"notable_events":null}'), null);
  assert.equal(parseSentimentResponse('{"sentiment":"bullish","intensity":50,"key_narratives":"none","notable_events":null}'), null);
  assert.equal(parseSentimentResponse('{"sentiment":"bullish","intensity":50,"key_narratives":[],"notable_events":42}'), null);
  assert.equal(parseSentimentResponse('{"sentiment":"bullish","intensity":50'), null);
});

test('missing XAI_API_KEY skips the module entirely', async () => {
  const db = openDb(':memory:');
  const cfg = { ...config, mock: false, xaiApiKey: '' };
  const out = await getSentiment('BTCUSDT', db, cfg);
  assert.deepEqual(out, { ...UNAVAILABLE_SENTIMENT });
  // nothing recorded, nothing logged — the layer simply isn't there
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sentiment_calls').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  db.close();
});

test('budget cap hit: skip, decay intensity by 30, reuse last sentiment', async () => {
  const db = openDb(':memory:');
  const cfg = { ...config, mock: false, xaiApiKey: 'test-key' };

  // A stale sentiment (older than the 4h cadence) so the cadence reuse path
  // does not short-circuit before the budget gate.
  const staleTs = new Date(Date.now() - 5 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO sentiment_calls (ts, pair, sentiment, intensity, key_narratives, notable_events, raw_json, est_cost, source)
     VALUES (?, 'BTCUSDT', 'very_bullish', 90, '["ETF inflows"]', NULL, '{}', 0.01, 'grok')`,
  ).run(staleTs);

  // Exhaust today's Grok budget (provider-scoped: anthropic spend untouched).
  addSpend(cfg.grokDailyBudgetUsd, db, undefined, 'grok');

  const out = await getSentiment('BTCUSDT', db, cfg);
  assert.equal(out.sentiment, 'very_bullish');
  assert.equal(out.intensity, 60); // 90 - 30 decay
  assert.deepEqual(out.key_narratives, ['ETF inflows']);

  const event = db.prepare("SELECT * FROM events WHERE type = 'GROK_BUDGET_SKIPPED'").get();
  assert.ok(event, 'GROK_BUDGET_SKIPPED event logged');
  // no new sentiment_calls row was written (no API call happened)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sentiment_calls').get().n, 1);
  db.close();
});

test('budget cap hit with no prior sentiment falls back to neutral', async () => {
  const db = openDb(':memory:');
  const cfg = { ...config, mock: false, xaiApiKey: 'test-key' };
  addSpend(cfg.grokDailyBudgetUsd, db, undefined, 'grok');
  const out = await getSentiment('ETHUSDT', db, cfg);
  assert.deepEqual(out, { ...FALLBACK_SENTIMENT });
  db.close();
});

test('intensity decay floors at zero', async () => {
  const db = openDb(':memory:');
  const cfg = { ...config, mock: false, xaiApiKey: 'test-key' };
  const staleTs = new Date(Date.now() - 5 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO sentiment_calls (ts, pair, sentiment, intensity, key_narratives, notable_events, raw_json, est_cost, source)
     VALUES (?, 'BTCUSDT', 'bearish', 20, '[]', NULL, '{}', 0.01, 'grok')`,
  ).run(staleTs);
  addSpend(cfg.grokDailyBudgetUsd, db, undefined, 'grok');
  const out = await getSentiment('BTCUSDT', db, cfg);
  assert.equal(out.intensity, 0); // 20 - 30 floors at 0
  db.close();
});
