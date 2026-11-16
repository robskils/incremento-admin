-- Incremento Admin - the blog queue.
-- Run: wrangler d1 execute incremento-admin --file worker/schema-blog.sql --remote
--
-- Robin: "we'd like to get the blog automation going for some of the other
-- properties." The LST admin has had this for a while; this is the same shape,
-- single-business, because this admin serves one.
--
-- A post goes idea -> written -> published. Only the last step is somebody
-- else's: a scheduled Action in incremento-site pulls the written ones and
-- commits the pages, and checkLive asks the web whether they arrived rather
-- than trusting a claim.
CREATE TABLE IF NOT EXISTS blog_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  slug         TEXT,
  status       TEXT NOT NULL DEFAULT 'idea',   -- idea | written | published
  keyword      TEXT,
  angle        TEXT,
  meta_desc    TEXT,
  body         TEXT,
  sort         INTEGER DEFAULT 0,
  created_at   TEXT,
  written_at   TEXT,
  published_at TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_blog_status ON blog_posts (status, sort, id);
