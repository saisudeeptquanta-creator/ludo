/**
 * Forward-only migration runner. Each .sql file in migrations/ runs once, in
 * filename order, inside a transaction, and is recorded in schema_migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db, transaction } from './index.js';
import { DB } from '../config/index.js';
import { logger } from '../utils/logger.js';

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );

  const files = fs
    .readdirSync(DB.migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DB.migrationsDir, file), 'utf8');
    transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    logger.info('migration.applied', { file });
    count += 1;
  }

  if (count === 0) logger.info('migration.up_to_date', { total: files.length });
  return count;
}

// Allow `node src/db/migrate.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = migrate();
  logger.info('migration.done', { applied: n });
  process.exit(0);
}
