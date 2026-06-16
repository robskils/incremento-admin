-- Incremento Admin — key/value settings (editable proposal email template, etc.)
-- Run: wrangler d1 execute incremento-admin --file worker/schema-settings.sql --remote
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
