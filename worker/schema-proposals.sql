-- Incremento Admin — Proposals table
-- Run: wrangler d1 execute incremento-admin --file worker/schema-proposals.sql --remote

CREATE TABLE IF NOT EXISTS proposals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id     INTEGER,                       -- optional link to enquiries.id
  token          TEXT    NOT NULL UNIQUE,       -- random URL token for the public page
  title          TEXT    NOT NULL,
  client_name    TEXT    NOT NULL,
  client_email   TEXT,
  client_company TEXT,
  status         TEXT    NOT NULL DEFAULT 'draft',  -- draft | sent | viewed | accepted | declined
  content        TEXT    NOT NULL DEFAULT '{}',     -- JSON: intro, scope[], deliverables[], timeline[], pricing[], terms
  total_value    INTEGER NOT NULL DEFAULT 0,        -- EUR
  valid_until    TEXT,                              -- ISO date
  created_at     TEXT    NOT NULL,
  updated_at     TEXT,
  sent_at        TEXT,
  viewed_at      TEXT,
  accepted_at    TEXT,
  signed_name    TEXT,                              -- full name typed by client on accept (e-signature)
  declined_at    TEXT,
  decline_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status  ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_token   ON proposals(token);
CREATE INDEX IF NOT EXISTS idx_proposals_enquiry ON proposals(enquiry_id);

-- Migration for existing databases (add the acceptance/decline columns):
--   ALTER TABLE proposals ADD COLUMN signed_name TEXT;
--   ALTER TABLE proposals ADD COLUMN declined_at TEXT;
--   ALTER TABLE proposals ADD COLUMN decline_reason TEXT;
