-- Incremento Admin — D1 Schema
-- Run: wrangler d1 execute incremento-admin --file worker/schema.sql

CREATE TABLE IF NOT EXISTS enquiries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  email        TEXT    NOT NULL,
  company      TEXT,
  interests    TEXT,           -- JSON array e.g. '["web-design","seo-growth"]'
  message      TEXT    NOT NULL,
  stage        TEXT    NOT NULL DEFAULT 'new',
  notes        TEXT,           -- internal admin notes
  value        INTEGER NOT NULL DEFAULT 0,  -- estimated project value in EUR
  submitted_at TEXT    NOT NULL,            -- ISO 8601 string
  updated_at   TEXT                         -- ISO 8601 string, set on PATCH
);

CREATE INDEX IF NOT EXISTS idx_enquiries_stage     ON enquiries(stage);
CREATE INDEX IF NOT EXISTS idx_enquiries_email     ON enquiries(email);
CREATE INDEX IF NOT EXISTS idx_enquiries_submitted ON enquiries(submitted_at DESC);
