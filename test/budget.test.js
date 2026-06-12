import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import {
  addSpend,
  costFromUsage,
  getDailySpend,
  grokCostFromUsage,
  wouldExceedBudget,
} from '../src/ai/budget.js';

test('spend accumulates per day and gates the cap', () => {
  const db = openDb(':memory:');
  const date = '2026-06-12';
  assert.equal(getDailySpend(db, date), 0);

  addSpend(0.2, db, date);
  addSpend(0.25, db, date);
  assert.ok(Math.abs(getDailySpend(db, date) - 0.45) < 1e-9);

  // next call estimated at $0.06 would push past the $0.50 cap -> skip
  assert.equal(wouldExceedBudget(0.06, 0.5, db, date), true);
  // a cheaper call still fits
  assert.equal(wouldExceedBudget(0.04, 0.5, db, date), false);

  // a different day starts fresh
  assert.equal(getDailySpend(db, '2026-06-13'), 0);
  assert.equal(wouldExceedBudget(0.06, 0.5, db, '2026-06-13'), false);
  db.close();
});

test('cost computed from token usage and Sonnet pricing constants', () => {
  // 2000 input @ $3/MTok + 300 output @ $15/MTok = 0.006 + 0.0045 = $0.0105
  const cost = costFromUsage(2000, 300, { inputPerMTok: 3, outputPerMTok: 15 });
  assert.ok(Math.abs(cost - 0.0105) < 1e-12);
});

test('spend is tracked independently per provider', () => {
  const db = openDb(':memory:');
  const date = '2026-06-12';
  addSpend(0.1, db, date, 'anthropic');
  addSpend(0.25, db, date, 'grok');
  assert.ok(Math.abs(getDailySpend(db, date, 'anthropic') - 0.1) < 1e-9);
  assert.ok(Math.abs(getDailySpend(db, date, 'grok') - 0.25) < 1e-9);
  // grok at its $0.30 cap does not gate anthropic
  assert.equal(wouldExceedBudget(0.06, 0.3, db, date, 'grok'), true);
  assert.equal(wouldExceedBudget(0.06, 0.5, db, date, 'anthropic'), false);
  db.close();
});

test('grok cost includes per-source Live Search charge', () => {
  // 600 in @ $3 + 250 out @ $15 + 10 sources @ $0.025
  // = 0.0018 + 0.00375 + 0.25 = $0.25555
  const cost = grokCostFromUsage(600, 250, 10, {
    grokPricing: { inputPerMTok: 3, outputPerMTok: 15 },
    xaiSearchCostPerSource: 0.025,
  });
  assert.ok(Math.abs(cost - 0.25555) < 1e-12);
});

test('ai_budget migration adds provider column and preserves existing rows', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tradepilot-')), 'old.db');
  // Simulate a pre-sentiment database: ai_budget keyed by date only.
  const old = new Database(tmp);
  old.exec('CREATE TABLE ai_budget (date TEXT PRIMARY KEY, spend REAL NOT NULL DEFAULT 0)');
  old.prepare('INSERT INTO ai_budget (date, spend) VALUES (?, ?)').run('2026-06-10', 0.42);
  old.close();

  const db = openDb(tmp);
  const cols = db.prepare('PRAGMA table_info(ai_budget)').all().map((c) => c.name);
  assert.ok(cols.includes('provider'));
  const row = db.prepare('SELECT * FROM ai_budget WHERE date = ?').get('2026-06-10');
  assert.equal(row.provider, 'anthropic');
  assert.ok(Math.abs(row.spend - 0.42) < 1e-12);
  db.close();
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});
