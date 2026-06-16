-- Incremento Admin — communication log
-- Run: wrangler d1 execute incremento-admin --file worker/schema-messages.sql --remote

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_email TEXT    NOT NULL,            -- the client this message is to/from
  enquiry_id    INTEGER,                     -- optional link
  proposal_id   INTEGER,                     -- optional link
  direction     TEXT    NOT NULL,            -- 'inbound' | 'outbound'
  kind          TEXT    NOT NULL DEFAULT 'email', -- email | enquiry | accepted | note
  subject       TEXT,
  body          TEXT,
  source        TEXT    NOT NULL DEFAULT 'system', -- 'system' (auto) | 'manual' (logged by Robin)
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_email    ON messages(contact_email);
CREATE INDEX IF NOT EXISTS idx_messages_proposal ON messages(proposal_id);
CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at DESC);
