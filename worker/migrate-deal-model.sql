-- Deal model: contacts, team, assignees, project title.
-- Additive + idempotent-safe (guards on inserts). Run once with --remote.

-- People at a deal's business (multiple per deal)
CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id  INTEGER,                       -- the deal this contact belongs to
  name        TEXT NOT NULL,
  email       TEXT,
  role        TEXT,                           -- their role at the business
  phone       TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_enquiry ON contacts(enquiry_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(email);

-- Internal team members
CREATE TABLE IF NOT EXISTS team_members (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  email   TEXT,
  active  INTEGER NOT NULL DEFAULT 1
);

-- Team members assigned to a deal
CREATE TABLE IF NOT EXISTS deal_assignees (
  enquiry_id INTEGER NOT NULL,
  member_id  INTEGER NOT NULL,
  PRIMARY KEY (enquiry_id, member_id)
);

-- Seed the team (guarded so re-runs don't duplicate)
INSERT INTO team_members (name, email, active)
  SELECT 'Robin', 'robin@incremento.co', 1
  WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE name = 'Robin');
INSERT INTO team_members (name, email, active)
  SELECT 'James', NULL, 1
  WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE name = 'James');

-- Backfill: every existing enquiry becomes a deal with a primary contact
INSERT INTO contacts (enquiry_id, name, email, is_primary, created_at)
  SELECT e.id, e.name, e.email, 1, e.submitted_at
  FROM enquiries e
  WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.enquiry_id = e.id);
