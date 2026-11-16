import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dbPath = path.resolve(config.databaseFile);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const emailStatusConstraint = "CHECK(status IN ('queue_pending','scheduled','sent','failed','cancelled'))";

const createEmailTableSql = `
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL ${emailStatusConstraint},
  created_at TEXT NOT NULL,
  sent_at TEXT,
  error TEXT,
  preview_url TEXT,
  cancelled_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const emailColumns = db.prepare('PRAGMA table_info(emails)').all();
const emailTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='emails'").get();
if (!emailColumns.length) {
  db.exec(createEmailTableSql);
} else if (
  !emailColumns.some((column) => column.name === 'cancelled_at')
  || !emailColumns.some((column) => column.name === 'timezone')
  || !emailTable.sql.includes("'queue_pending'")
) {
  const legacyTimezone = emailColumns.some((column) => column.name === 'timezone') ? 'timezone' : "'UTC'";
  db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS idx_emails_user_created;
      DROP INDEX IF EXISTS idx_emails_schedule;
      ALTER TABLE emails RENAME TO emails_legacy;
      ${createEmailTableSql}
      INSERT INTO emails(id, user_id, to_email, subject, body, scheduled_at, timezone, status, created_at, sent_at, error, preview_url, cancelled_at)
      SELECT id, user_id, to_email, subject, body, scheduled_at, ${legacyTimezone}, status, created_at, sent_at, error, preview_url, NULL
      FROM emails_legacy;
      DROP TABLE emails_legacy;
    `);
  })();
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_emails_user_created ON emails(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_emails_schedule ON emails(status, scheduled_at);
  CREATE TABLE IF NOT EXISTS email_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('sent','retrying','failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(email_id) REFERENCES emails(id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_attempts_email ON email_attempts(email_id, created_at DESC);
`);
