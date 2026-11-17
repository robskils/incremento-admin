-- Robin: "incremento writes in english but translates into all the languages
-- of the blog - several."
--
-- Five: en, pt, es, fr, de. Each gets its own page, its own localised slug
-- and an hreflang set pointing at the other four, which is how the existing
-- sixteen posts are built. The English is written first and is the source;
-- the rest are translations of it, kept here beside it as JSON keyed by
-- language, so one post is one row however many languages it ends up in.
ALTER TABLE blog_posts ADD COLUMN translations TEXT;
