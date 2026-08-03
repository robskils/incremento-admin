-- Invoices. Line items stored as JSON on the row (solo dashboard - no join needed).
-- Issuer details (name, NIF, IBAN, IVA rate, terms, numbering) live in the
-- settings key/value table under invoice_* keys, so nothing legal is hardcoded.
CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT,                              -- display number, e.g. 2026-001
  status         TEXT NOT NULL DEFAULT 'draft',     -- draft | sent | paid
  enquiry_id     INTEGER,                           -- optional link to a deal
  client_name    TEXT,
  client_email   TEXT,
  client_company TEXT,
  client_address TEXT,
  client_nif     TEXT,
  issue_date     TEXT,
  due_date       TEXT,
  currency       TEXT DEFAULT 'EUR',
  items          TEXT,                              -- JSON: [{description, qty, unit_price}]
  subtotal       REAL DEFAULT 0,
  tax_rate       REAL DEFAULT 0,                    -- percent (0 = exempt)
  tax_amount     REAL DEFAULT 0,
  total          REAL DEFAULT 0,
  notes          TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  paid_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
