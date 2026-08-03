-- CRM overlay for contacts: category + notes, keyed by email.
-- Non-destructive - sits on top of the derived people list (enquiries + contacts).
-- A row exists only when a contact has been classified or added manually.
CREATE TABLE IF NOT EXISTS contact_meta (
  email       TEXT PRIMARY KEY,          -- lowercased
  name        TEXT,
  company     TEXT,
  phone       TEXT,
  category    TEXT,                       -- comma-separated: lead,prospect,client,past_client,partner
  notes       TEXT,
  standalone  INTEGER NOT NULL DEFAULT 0, -- 1 = added manually, not derived from a deal
  created_at  TEXT,
  updated_at  TEXT
);
