// SQLite setup and helpers. Every AI decision and every rule decision must be
// explainable from this database alone.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS regime_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  pair          TEXT NOT NULL,
  regime        TEXT NOT NULL,
  confidence    REAL NOT NULL,
  trade_allowed INTEGER NOT NULL,
  reasoning     TEXT,
  raw_json      TEXT,
  summary_json  TEXT,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  est_cost      REAL DEFAULT 0,
  source        TEXT DEFAULT 'claude'
);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pair        TEXT NOT NULL,
  side        TEXT NOT NULL DEFAULT 'long',
  status      TEXT NOT NULL DEFAULT 'open',
  entry_time  TEXT NOT NULL,
  entry_price REAL NOT NULL,
  qty         REAL NOT NULL,
  stop_price  REAL NOT NULL,
  tp_price    REAL NOT NULL,
  entry_fee   REAL NOT NULL DEFAULT 0,
  exit_time   TEXT,
  exit_price  REAL,
  exit_fee    REAL,
  pnl         REAL,
  exit_reason TEXT
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  equity REAL NOT NULL,
  cash   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_budget (
  date     TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  spend    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, provider)
);

CREATE TABLE IF NOT EXISTS sentiment_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  pair           TEXT NOT NULL,
  sentiment      TEXT NOT NULL,
  intensity      REAL NOT NULL,
  key_narratives TEXT,
  notable_events TEXT,
  raw_json       TEXT,
  input_tokens   INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  search_sources INTEGER DEFAULT 0,
  est_cost       REAL DEFAULT 0,
  source         TEXT DEFAULT 'grok'
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  type   TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS portfolio (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  cash REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_equity (
  date        TEXT PRIMARY KEY,
  open_equity REAL NOT NULL
);
`;

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  migrateAiBudget(db);
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO portfolio (id, cash) VALUES (1, ?)').run(config.startBalance);
  return db;
}

// Pre-sentiment DBs have ai_budget keyed by date only. Rebuild with a
// (date, provider) primary key, defaulting existing rows to 'anthropic'.
function migrateAiBudget(db) {
  const cols = db.prepare('PRAGMA table_info(ai_budget)').all();
  if (cols.length === 0 || cols.some((c) => c.name === 'provider')) return;
  db.exec(`
    ALTER TABLE ai_budget RENAME TO ai_budget_old;
    CREATE TABLE ai_budget (
      date     TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      spend    REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (date, provider)
    );
    INSERT INTO ai_budget (date, provider, spend)
      SELECT date, 'anthropic', spend FROM ai_budget_old;
    DROP TABLE ai_budget_old;
  `);
}

let _db = null;

export function getDb() {
  if (!_db) _db = openDb();
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function logEvent(type, detail, db = getDb()) {
  db.prepare('INSERT INTO events (ts, type, detail) VALUES (?, ?, ?)').run(
    nowIso(),
    type,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
