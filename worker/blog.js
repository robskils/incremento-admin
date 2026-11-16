/**
 * blog.js - from a title in a list to a page on incremento.eu.
 *
 * Robin: "we'd like to get the blog automation going for some of the other
 * properties." The LST admin has had this for a while and this is the same
 * shape, single-business, because this admin serves one.
 *
 * HOW IT REACHES THE SITE. incremento.eu is static HTML deployed by Pages
 * from a git push, and this worker has no GitHub token - nor should it need
 * one. So: posts live in D1, the worker serves the written ones at a public
 * endpoint, and a scheduled Action in incremento-site fetches them and
 * commits the pages. Nothing to remember, no new secret, the site stays
 * static.
 *
 * A post goes idea -> written -> published, and only the last step is
 * somebody else's. checkLive asks the web whether a page arrived rather than
 * trusting a claim, so the status is the truth.
 */

const MODEL = 'claude-opus-5-5';
const SITE  = 'https://incremento.eu';
const PATH  = '/blog/';

/* The voice. Kept here rather than in the prompt body so it reads as policy. */
const HOUSE_RULES = `
Write for Incremento, a digital agency in Lisbon. It builds websites, runs SEO
and does AI consultancy, mostly for small and mid-sized businesses in Portugal
- law firms, clinics, accountants, agencies, small manufacturers.

The reader is an owner or a marketing lead who has been sold vague things
before and is wary of being sold another. Write for somebody deciding, not
somebody browsing.

Concrete and unsentimental. Specific numbers, named tools, real constraints,
real timescales. Say the awkward thing before the sell: what a project will
not do, what it costs, how long it takes, when it is the wrong thing to buy.

Plain English, British spelling, a single hyphen and never an em dash. No "in
today's digital landscape", no "unlock", no "leverage", no "game-changer", no
"nestled", no exclamation marks. Short paragraphs.

Do not invent prices, statistics, case studies or client names. If a number
would help and you do not have one, write around it. A made-up statistic on an
agency's own blog is the worst possible advertisement for its judgement.

End with a plain invitation to get in touch - no hard sell.
`;

export function slugify(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Write the post. Returns { body, meta_desc } or throws. */
export async function writePost(env, post) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('No ANTHROPIC_API_KEY');

  const prompt = `${HOUSE_RULES}

Write a blog post for incremento.eu.

TITLE: ${post.title}
IT SHOULD RANK FOR: ${post.keyword || post.title}
THE ANGLE: ${post.angle || 'Help the reader decide something.'}

Return ONLY a JSON object, no other text:
{
  "meta": "a meta description under 155 characters, written to be clicked",
  "html": "the post body as HTML"
}

The HTML: no <h1> (the page supplies it), use <h2> for sections, <p>, <ul>,
<li>, <strong>. No inline styles, no classes, no <script>. 800 to 1200 words.
Open with the question the reader actually has, answered in the first
paragraph - not with a scene.

Work the search phrase in naturally where it belongs, including one <h2>.
Never at the cost of a sentence reading badly.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 5000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic ' + res.status + ' ' + (await res.text()).slice(0, 200));

  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('').trim();
  /* The model is asked for bare JSON and usually obliges; a fenced block is
     the one deviation worth forgiving rather than failing the whole run on. */
  const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let out;
  try { out = JSON.parse(raw); }
  catch (e) { throw new Error('Could not read the reply as JSON: ' + raw.slice(0, 160)); }
  if (!out.html || out.html.length < 400) throw new Error('The post came back too short');
  return { body: out.html, meta_desc: String(out.meta || '').slice(0, 300) };
}

/* ── THE SCHEDULE ──────────────────────────────────────────────────────────
 * Which days, until when, on or off. The cron still fires; this decides
 * whether anything happens when it does, so changing the rhythm or stopping
 * it is a setting rather than a deploy. `until` empty means open ended.
 */
const SCHEDULE_DEFAULT = { on: true, days: [2, 5], until: '' };   // Tue and Fri

export async function loadSchedule(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'blog_schedule'"
  ).first().catch(() => null);
  if (!row || !row.value) return { ...SCHEDULE_DEFAULT };
  try {
    const v = JSON.parse(row.value) || {};
    return {
      on:    v.on !== false,
      days:  Array.isArray(v.days) && v.days.length ? v.days.map(Number) : SCHEDULE_DEFAULT.days,
      until: String(v.until || ''),
    };
  } catch (e) { return { ...SCHEDULE_DEFAULT }; }
}

export async function saveSchedule(env, next) {
  const clean = {
    on:    next.on !== false,
    days:  Array.isArray(next.days)
             ? [...new Set(next.days.map(Number))].filter(d => d >= 0 && d <= 6).sort()
             : SCHEDULE_DEFAULT.days,
    until: /^\d{4}-\d{2}-\d{2}$/.test(String(next.until || '')) ? String(next.until) : '',
  };
  if (!clean.days.length) clean.days = SCHEDULE_DEFAULT.days;
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('blog_schedule', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(JSON.stringify(clean)).run();
  return clean;
}

/** Should anything be written today, and has it been already? */
export async function maybeWrite(env) {
  const cfg = await loadSchedule(env);
  if (!cfg.on) return { skipped: 'the schedule is off' };

  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  if (cfg.until && today > cfg.until) return { skipped: 'past the stop date' };
  if (!cfg.days.includes(now.getUTCDay())) return { skipped: 'not one of the chosen days' };

  const already = await env.DB.prepare(
    `SELECT id FROM blog_posts
      WHERE written_at IS NOT NULL AND substr(written_at, 1, 10) = ? LIMIT 1`
  ).bind(today).first().catch(() => null);
  if (already) return { skipped: 'one has already been written today' };

  return await publishNext(env);
}

/**
 * Write the next idea in the running order. One at a time: a failure costs
 * one post and the queue is untouched, and a run that wrote three would empty
 * eight weeks of ideas in a fortnight.
 */
export async function publishNext(env) {
  const post = await env.DB.prepare(
    "SELECT * FROM blog_posts WHERE status = 'idea' ORDER BY sort, id LIMIT 1"
  ).first();
  if (!post) return { ok: false, none: true };

  const now = new Date().toISOString();
  try {
    const { body, meta_desc } = await writePost(env, post);
    const slug = post.slug || slugify(post.title);
    /* WRITTEN, NOT PUBLISHED. Nothing this worker can do puts a page on
       incremento.eu - the site is committed HTML. Marking these 'published'
       would claim something that has not happened, so they wait here until
       the Action in the site repo has actually committed them. */
    await env.DB.prepare(
      `UPDATE blog_posts
          SET body = ?, meta_desc = ?, slug = ?, status = 'written',
              written_at = ?, error = NULL
        WHERE id = ?`
    ).bind(body, meta_desc, slug, now, post.id).run();

    let built = false;
    if (env.PAGES_DEPLOY_HOOK) {
      try {
        const r = await fetch(env.PAGES_DEPLOY_HOOK, { method: 'POST' });
        built = r.ok;
        if (!r.ok) console.error('blog: deploy hook said', r.status);
      } catch (e) { console.error('blog: deploy hook', e && e.message); }
    }
    console.log('blog: wrote', slug);
    return { ok: true, id: post.id, slug, title: post.title, built, written: true };
  } catch (e) {
    /* Stays an idea, with the reason on it, so it is tried again next time
       rather than lost - and so Robin can see why if it keeps failing. */
    await env.DB.prepare('UPDATE blog_posts SET error = ? WHERE id = ?')
      .bind(String(e && e.message || e).slice(0, 400), post.id).run();
    console.error('blog: could not write', post.id, e && e.message);
    return { ok: false, id: post.id, error: String(e && e.message || e) };
  }
}

/** Is it actually on the web yet? Ask, rather than assume. */
export async function checkLive(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug FROM blog_posts WHERE status = 'written' AND slug IS NOT NULL LIMIT 20"
  ).all().catch(() => ({ results: [] }));
  if (!results || !results.length) return { checked: 0, live: 0 };

  let live = 0;
  for (const p of results) {
    try {
      const r = await fetch(`${SITE}${PATH}${p.slug}/`, { method: 'GET', redirect: 'follow' });
      if (!r.ok) continue;
      await env.DB.prepare(
        `UPDATE blog_posts SET status = 'published', published_at = ?
          WHERE id = ? AND status = 'written'`
      ).bind(new Date().toISOString(), p.id).run();
      live++;
      console.log('blog: live now', p.slug);
    } catch (e) { /* not up yet, try again next time */ }
  }
  return { checked: results.length, live };
}

/** Everything written, newest first. PUBLIC: this is what the site reads. */
export async function publishedPosts(env) {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, meta_desc, body, published_at, written_at
       FROM blog_posts
      WHERE status IN ('written', 'published') AND slug IS NOT NULL
      ORDER BY COALESCE(published_at, written_at) DESC`
  ).all().catch(() => ({ results: [] }));
  return results || [];
}

/** The admin's own list, and the edits it makes. */
export async function handleBlogPosts(request, env, url, cors) {
  const method = request.method;
  const json = (d, s = 200) => new Response(JSON.stringify(d), {
    status: s, headers: { 'Content-Type': 'application/json', ...cors },
  });

  const idm = url.pathname.match(/\/api\/blog-posts\/(\d+)$/);

  if (method === 'GET' && idm) {
    const post = await env.DB.prepare('SELECT * FROM blog_posts WHERE id = ?')
      .bind(parseInt(idm[1], 10)).first().catch(() => null);
    return post ? json({ ok: true, post }) : json({ ok: false, error: 'No post with that id' }, 404);
  }

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, title, slug, status, keyword, angle, meta_desc, sort,
              created_at, written_at, published_at, error,
              CASE WHEN body IS NULL THEN 0 ELSE length(body) END AS words
         FROM blog_posts ORDER BY (status = 'published'), sort, id`
    ).all().catch(() => ({ results: [] }));
    return json({ ok: true, posts: results || [], site: SITE + PATH });
  }

  if (method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const title = String(b.title || '').trim();
    if (!title) return json({ ok: false, error: 'It needs a title' }, 400);
    const row = await env.DB.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM blog_posts').first();
    const r = await env.DB.prepare(
      `INSERT INTO blog_posts (title, keyword, angle, status, sort, created_at)
       VALUES (?, ?, ?, 'idea', ?, ?)`
    ).bind(title, String(b.keyword || '').trim() || null,
           String(b.angle || '').trim() || null,
           (row && row.next) || 0, new Date().toISOString()).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  if (method === 'PATCH' && idm) {
    const b = await request.json().catch(() => ({}));
    const sets = [], binds = [];
    for (const f of ['title', 'keyword', 'angle', 'sort', 'status']) {
      if (f in b) { sets.push(`${f} = ?`); binds.push(b[f]); }
    }
    if (!sets.length) return json({ ok: false, error: 'Nothing to change' }, 400);
    binds.push(parseInt(idm[1], 10));
    await env.DB.prepare(`UPDATE blog_posts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }

  /* Only an idea can be deleted. A written post is work that exists, and a
     published one is a page somebody may be linking to. */
  if (method === 'DELETE' && idm) {
    await env.DB.prepare("DELETE FROM blog_posts WHERE id = ? AND status = 'idea'")
      .bind(parseInt(idm[1], 10)).run();
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
