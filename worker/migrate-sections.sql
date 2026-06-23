-- Proposal structure: ordered sections of a proposal document.
-- shared_content feeds into every proposal; per-proposal content is built in the editor.
CREATE TABLE IF NOT EXISTS proposal_sections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  position       INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL,
  description    TEXT,            -- guidance: what this section is for
  shared_content TEXT,           -- default content used in every proposal
  created_at     TEXT
);

-- Link a library component to the section of the proposal it belongs in.
ALTER TABLE proposal_blocks ADD COLUMN section_id INTEGER;

-- Seed the default structure (only if the table is empty).
INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 1, 'Introduction & Executive Summary',
  'Hook the client immediately. Summarise their core business goals, identify their primary challenges, and give a high-level overview of how your customised strategy will drive results and ROI.',
  '', '2026-06-22'
WHERE NOT EXISTS (SELECT 1 FROM proposal_sections);

INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 2, 'Project Objectives',
  'Define clear goals (e.g. increasing conversion rates, improving SEO rankings, or lowering cost-per-acquisition) using the SMART framework so progress stays completely quantifiable.',
  '', '2026-06-22'
WHERE (SELECT COUNT(*) FROM proposal_sections) = 1;

INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 3, 'Proposed Solution & Scope of Work',
  'Break the deliverables into distinct phases. Website Development: wireframing, UI/UX design, CMS integration, mobile responsiveness, speed optimisation. Digital Marketing: SEO (on-page/off-page), PPC/paid ads (Google, Meta, LinkedIn), content strategy, email automation.',
  '', '2026-06-22'
WHERE (SELECT COUNT(*) FROM proposal_sections) = 2;

INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 4, 'Timeline & Milestones',
  'Detail the expected launch timeframe, dividing the project into weekly or monthly milestones (e.g. Phase 1: wireframing, Phase 2: SEO audit & campaign launch, Phase 3: reporting).',
  '', '2026-06-22'
WHERE (SELECT COUNT(*) FROM proposal_sections) = 3;

INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 5, 'Pricing & Investment',
  'Provide transparent, itemised pricing. Break down initial website development costs from recurring monthly marketing retainers.',
  '', '2026-06-22'
WHERE (SELECT COUNT(*) FROM proposal_sections) = 4;

INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 6, 'Reporting & Analytics',
  'Detail how you will track success. Explain the KPIs you will monitor and how often you will share performance reports.',
  '', '2026-06-22'
WHERE (SELECT COUNT(*) FROM proposal_sections) = 5;

INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
SELECT 7, 'Terms & Next Steps',
  'Outline your payment terms and project contracts, with a clear call-to-action (e.g. e-signature) on how to initiate the project.',
  '', '2026-06-22'
WHERE (SELECT COUNT(*) FROM proposal_sections) = 6;
