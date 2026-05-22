/* ═══════════════════════════════════════════════════════════
   Incremento Enquiry Worker
   ─ POST /          → receive form submission, email + store in D1
   ─ GET  /api/enquiries    → list all (admin, requires X-Admin-Key)
   ─ GET  /api/enquiries/:id → single enquiry
   ─ PATCH /api/enquiries/:id → update stage / notes / value
   ─ GET  /api/stats        → dashboard KPIs
   ═══════════════════════════════════════════════════════════ */

const PUBLIC_ORIGINS = ['https://incremento.co', 'https://www.incremento.co'];
const ADMIN_ORIGINS  = [
  'https://admin.incremento.co',
  'https://incremento-admin.pages.dev',
  // add your actual Pages URL here when known
];
const ALL_ORIGINS = [...PUBLIC_ORIGINS, ...ADMIN_ORIGINS];

function corsHeaders(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALL_ORIGINS.includes(origin) ? origin : PUBLIC_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Vary': 'Origin',
  };
}

function json(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Entry point ─────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // Public: form submission
    if (request.method === 'POST' && url.pathname === '/') {
      return handleEnquiry(request, env, cors);
    }

    // Admin API
    if (url.pathname.startsWith('/api/')) {
      return handleAdmin(request, env, url, cors);
    }

    return new Response('incremento enquiry worker', { status: 200, headers: cors });
  },
};

/* ── Auth check ──────────────────────────────────────────── */
function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key');
  return env.ADMIN_KEY && key === env.ADMIN_KEY;
}

/* ── Admin router ────────────────────────────────────────── */
async function handleAdmin(request, env, url, cors) {
  if (!isAdmin(request, env)) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  const path    = url.pathname;
  const method  = request.method;
  const idMatch = path.match(/^\/api\/enquiries\/(\d+)$/);

  if (path === '/api/enquiries' && method === 'GET') {
    return listEnquiries(request, env, url, cors);
  }
  if (idMatch && method === 'GET') {
    return getEnquiry(parseInt(idMatch[1]), env, cors);
  }
  if (idMatch && method === 'PATCH') {
    return updateEnquiry(parseInt(idMatch[1]), request, env, cors);
  }
  if (path === '/api/stats' && method === 'GET') {
    return getStats(env, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

/* ── POST / → form submission ────────────────────────────── */
async function handleEnquiry(request, env, cors) {
  let data;
  try { data = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { name, email, company, interests = [], message } = data;

  if (!name || !email || !message) {
    return json({ error: 'Missing required fields' }, 400, cors);
  }

  const submitted = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/Lisbon',
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const submittedISO = new Date().toISOString();
  const interestList = interests.length ? interests.join(', ') : 'Not specified';

  // 1. Store in D1 (graceful — if DB not set up, still send email)
  try {
    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO enquiries (name, email, company, interests, message, stage, submitted_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?)`
      ).bind(name, email, company || null, JSON.stringify(interests), message, submittedISO).run();
    }
  } catch (dbErr) {
    console.error('D1 insert error:', dbErr);
  }

  // 2. Send email via Resend
  const html = buildEmailHtml({ name, email, company, interestList, message, submitted });
  const plain = `New enquiry from ${name} (${email})${company ? ` · ${company}` : ''}\n\nInterested in: ${interestList}\n\nMessage:\n${message}\n\nSubmitted: ${submitted}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:     `Incremento Enquiries <${env.FROM_EMAIL}>`,
      to:       [env.TO_EMAIL],
      reply_to: email,
      subject:  `New enquiry from ${name}${company ? ` · ${company}` : ''}`,
      html,
      text: plain,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
    return json({ error: 'Failed to send email' }, 502, cors);
  }

  return json({ ok: true }, 200, cors);
}

/* ── GET /api/enquiries ──────────────────────────────────── */
async function listEnquiries(request, env, url, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);

  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const stage  = url.searchParams.get('stage');

  let query  = 'SELECT * FROM enquiries';
  const args = [];
  if (stage) { query += ' WHERE stage = ?'; args.push(stage); }
  query += ' ORDER BY submitted_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  try {
    const result = await env.DB.prepare(query).bind(...args).all();
    return json({ enquiries: result.results || [] }, 200, cors);
  } catch (err) {
    console.error('D1 list error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── GET /api/enquiries/:id ──────────────────────────────── */
async function getEnquiry(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    const row = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404, cors);
    return json(row, 200, cors);
  } catch (err) {
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── PATCH /api/enquiries/:id ────────────────────────────── */
async function updateEnquiry(id, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { stage, notes, value } = body;
  const updatedAt = new Date().toISOString();

  const setClauses = [];
  const args = [];

  if (stage !== undefined) { setClauses.push('stage = ?');      args.push(stage); }
  if (notes !== undefined) { setClauses.push('notes = ?');      args.push(notes); }
  if (value !== undefined) { setClauses.push('value = ?');      args.push(Number(value) || 0); }
  setClauses.push('updated_at = ?'); args.push(updatedAt);

  if (setClauses.length === 1) {
    return json({ error: 'Nothing to update' }, 400, cors);
  }

  args.push(id);

  try {
    await env.DB.prepare(
      `UPDATE enquiries SET ${setClauses.join(', ')} WHERE id = ?`
    ).bind(...args).run();

    const updated = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ?').bind(id).first();
    return json(updated || { ok: true }, 200, cors);
  } catch (err) {
    console.error('D1 update error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── GET /api/stats ──────────────────────────────────────── */
async function getStats(env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);

  try {
    const [totalRes, stageRes, revenueRes] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM enquiries').first(),
      env.DB.prepare(`SELECT stage, COUNT(*) as count FROM enquiries GROUP BY stage`).all(),
      env.DB.prepare(`SELECT SUM(value) as total FROM enquiries WHERE stage NOT IN ('cancelled','on_hold') AND value > 0`).first(),
    ]);

    return json({
      total:             totalRes?.count || 0,
      new_count:         (stageRes.results || []).find(r => r.stage === 'new')?.count || 0,
      stage_counts:      stageRes.results || [],
      potential_revenue: revenueRes?.total || 0,
    }, 200, cors);
  } catch (err) {
    console.error('D1 stats error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── Email HTML builder ──────────────────────────────────── */
function buildEmailHtml({ name, email, company, interestList, message, submitted }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0f14;font-family:Inter,ui-sans-serif,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f14;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#0e1820;border-radius:12px;overflow:hidden;max-width:600px;width:100%;border:1px solid rgba(255,255,255,0.06)">

        <tr>
          <td style="padding:28px 36px;background:linear-gradient(135deg,#9EF54A,#5EE7D8);text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#0a1219">New enquiry via</p>
            <p style="margin:5px 0 0;font-size:22px;font-weight:700;color:#0a1219;letter-spacing:-0.02em;font-family:'Space Grotesk',sans-serif">incremento<span style="opacity:0.7">.</span></p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 36px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="50%" style="padding-bottom:20px">
                      <p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Name</p>
                      <p style="margin:0;font-size:16px;color:#e0e8f0">${escHtml(name)}</p>
                    </td>
                    <td width="50%" style="padding-bottom:20px">
                      <p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Email</p>
                      <p style="margin:0;font-size:16px"><a href="mailto:${escHtml(email)}?subject=Re: Your enquiry to Incremento" style="color:#9EF54A;text-decoration:none">${escHtml(email)}</a></p>
                    </td>
                  </tr>
                  ${company ? `<tr><td colspan="2" style="padding-bottom:20px"><p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Company</p><p style="margin:0;font-size:16px;color:#e0e8f0">${escHtml(company)}</p></td></tr>` : ''}
                  <tr><td colspan="2" style="padding-bottom:20px">
                    <p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Interested in</p>
                    <p style="margin:0;font-size:16px;color:#e0e8f0">${escHtml(interestList)}</p>
                  </td></tr>
                </table>
              </td></tr>
              <tr><td style="padding-top:20px">
                <p style="margin:0 0 8px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Message</p>
                <div style="background:#152332;border-radius:8px;padding:18px;border-left:3px solid #9EF54A">
                  <p style="margin:0;font-size:15px;color:#b0bec8;line-height:1.7;white-space:pre-wrap">${escHtml(message)}</p>
                </div>
              </td></tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px">
              <tr>
                <td align="center">
                  <a href="mailto:${escHtml(email)}?subject=Re: Your enquiry to Incremento"
                     style="display:inline-block;background:linear-gradient(135deg,#9EF54A,#5EE7D8);color:#0a1219;font-weight:700;font-size:14px;padding:13px 28px;border-radius:8px;text-decoration:none;letter-spacing:-0.01em">
                    Reply to ${escHtml(name)} →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 36px;border-top:1px solid rgba(255,255,255,0.06);text-align:center">
            <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.25)">${submitted} · Lisbon</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
