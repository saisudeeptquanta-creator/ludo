/**
 * SQLite connection built on Node's built-in `node:sqlite` — no native module
 * compilation, real transactions, enforced foreign keys.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB } from '../config/index.js';

fs.mkdirSync(path.dirname(DB.file), { recursive: true });

export const db = new DatabaseSync(DB.file);

// WAL lets readers run while a game-state write transaction is open.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

/** Prepared-statement cache — statements are reused across requests. */
const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export const query = (sql, ...params) => prep(sql).all(...params);
export const get = (sql, ...params) => prep(sql).get(...params) ?? null;
export const run = (sql, ...params) => prep(sql).run(...params);

/**
 * Run `fn` inside an IMMEDIATE transaction. Every game-state mutation goes
 * through here so that a roll and its resulting broadcast can never interleave
 * with a second roll (see docs/ARCHITECTURE.md § race conditions).
 * Nested calls join the outer transaction.
 */
let depth = 0;
export function transaction(fn) {
  if (depth > 0) return fn();
  depth += 1;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback of an already-aborted txn is not itself an error */
    }
    throw err;
  } finally {
    depth -= 1;
  }
}

export function closeDb() {
  stmtCache.clear();
  db.close();
}
