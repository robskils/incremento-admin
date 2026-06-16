/* ═══════════════════════════════════════════════════════════
   Incremento Enquiry Worker
   ─ POST /          → receive form submission, email + store in D1
   ─ GET  /api/enquiries    → list all (admin, requires X-Admin-Key)
   ─ GET  /api/enquiries/:id → single enquiry
   ─ PATCH /api/enquiries/:id → update stage / notes / value
   ─ GET  /api/stats        → dashboard KPIs
   ─ POST /api/proposals/draft → AI-draft proposal content from an enquiry
   ─ CRUD /api/proposals[...] → proposal management
   ─ POST /api/proposals/:id/send → email proposal link to client
   ─ GET  /p/:token         → public branded proposal page (no auth)
   ─ POST /p/:token/accept  → client accepts the proposal (no auth)
   ═══════════════════════════════════════════════════════════ */

const PUBLIC_ORIGINS = ['https://incremento.co', 'https://www.incremento.co'];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
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

    // Public: proposal pages
    const pubMatch = url.pathname.match(/^\/p\/([A-Za-z0-9_-]+)(\/accept|\/decline)?$/);
    if (pubMatch) {
      if (request.method === 'GET' && !pubMatch[2]) {
        return renderProposalPage(pubMatch[1], env, url);
      }
      if (request.method === 'POST' && pubMatch[2] === '/accept') {
        return acceptProposal(pubMatch[1], request, env, cors);
      }
      if (request.method === 'POST' && pubMatch[2] === '/decline') {
        return declineProposal(pubMatch[1], request, env, cors);
      }
    }

    // Public: inbound email capture (Mailgun webhook, secured by ?token=)
    if (request.method === 'POST' && url.pathname === '/api/inbound-email') {
      return handleInboundEmail(request, env, url, cors);
    }

    // Public: email OTP login
    if (request.method === 'POST' && url.pathname === '/auth/request-code') {
      return authRequestCode(request, env, cors);
    }
    if (request.method === 'POST' && url.pathname === '/auth/verify') {
      return authVerify(request, env, cors);
    }

    // Admin API
    if (url.pathname.startsWith('/api/')) {
      return handleAdmin(request, env, url, cors);
    }

    return new Response('incremento enquiry worker', { status: 200, headers: cors });
  },
};

/* ── Auth ────────────────────────────────────────────────── */
/* Two ways in:
   1. Email OTP login → signed session token (Authorization: Bearer)
   2. Legacy X-Admin-Key header (kept as fallback)
   Session tokens are HS256 JWTs signed with ADMIN_KEY. */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signJWT(payload, secret) {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const b = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${b}`)));
  return `${h}.${b}.${sig}`;
}
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, fromB64url(sig), enc.encode(`${h}.${b}`));
  if (!ok) return null;
  const payload = JSON.parse(dec.decode(fromB64url(b)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function allowedEmails(env) {
  return (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

async function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key');
  if (env.ADMIN_KEY && key === env.ADMIN_KEY) return true;

  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && env.ADMIN_KEY) {
    try {
      const payload = await verifyJWT(auth.slice(7), env.ADMIN_KEY);
      return !!payload && allowedEmails(env).includes((payload.sub || '').toLowerCase());
    } catch { return false; }
  }
  return false;
}

/* ── POST /auth/request-code ─────────────────────────────── */
async function authRequestCode(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email' }, 400, cors);
  }
  if (!allowedEmails(env).includes(email)) {
    return json({ error: "This email isn't authorised for admin access" }, 403, cors);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  await env.DB.prepare(
    `INSERT INTO otp_codes (email, code, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`
  ).bind(email, code, expiresAt).run();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `Incremento Admin <${env.FROM_EMAIL}>`,
      to: [email],
      subject: `${code} is your Incremento Admin code`,
      html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:0;background:#0a0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f14;padding:40px 0">
    <tr><td align="center">
      <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="width:440px;max-width:440px;background:#0e1820;border-radius:16px;overflow:hidden;border:1px solid #1c2d40">
        <tr>
          <td style="background:#9EF54A;padding:26px 36px">
            <p style="margin:0;font-size:20px;font-weight:700;color:#0a1219;letter-spacing:-0.02em">incremento<span style="color:#0a1219">.</span> <span style="font-weight:400;font-size:14px;color:#0a1219">admin</span></p>
          </td>
        </tr>
        <tr>
          <td style="padding:34px 36px">
            <p style="margin:0 0 24px;font-size:15px;color:#cdd9e5;line-height:1.6">Here's your sign-in code. It expires in <strong style="color:#ffffff">10 minutes</strong>.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="background:#152332;border:1px solid #24384f;border-radius:12px;padding:24px">
                <span style="font-size:40px;font-weight:800;letter-spacing:0.22em;color:#9EF54A;font-family:'Courier New',monospace">${code}</span>
              </td></tr>
            </table>
            <p style="margin:26px 0 0;font-size:12px;color:#7d93a8;line-height:1.6">Didn't request this? You can safely ignore this email.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 36px;border-top:1px solid #1c2d40">
            <p style="margin:0;font-size:11px;color:#5a7186">Incremento · Lisbon · <a href="https://incremento.co" style="color:#5EE7D8;text-decoration:none">incremento.co</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      text: `Your Incremento Admin sign-in code is ${code}. It expires in 10 minutes.`,
    }),
  });

  if (!res.ok) {
    console.error('OTP email error:', await res.text());
    return json({ error: 'Failed to send code' }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

/* ── POST /auth/verify ───────────────────────────────────── */
async function authVerify(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const email = String(body.email || '').trim().toLowerCase();
  const code  = String(body.code || '').trim();
  if (!email || !code) return json({ error: 'Missing email or code' }, 400, cors);

  const row = await env.DB.prepare(`SELECT code, expires_at FROM otp_codes WHERE email = ?`)
    .bind(email).first();
  if (!row) return json({ error: 'No code found — request a new one' }, 400, cors);

  const now = Math.floor(Date.now() / 1000);
  if (now > row.expires_at) {
    await env.DB.prepare(`DELETE FROM otp_codes WHERE email = ?`).bind(email).run();
    return json({ error: 'Code expired — request a new one' }, 400, cors);
  }
  if (row.code !== code) return json({ error: 'Incorrect code' }, 400, cors);

  await env.DB.prepare(`DELETE FROM otp_codes WHERE email = ?`).bind(email).run();

  const token = await signJWT(
    { sub: email, exp: now + 60 * 60 * 24 * 7 },  // 7 days
    env.ADMIN_KEY
  );
  return json({ token }, 200, cors);
}

/* ── Admin router ────────────────────────────────────────── */
async function handleAdmin(request, env, url, cors) {
  if (!(await isAdmin(request, env))) {
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

  // Proposals
  const propId   = path.match(/^\/api\/proposals\/(\d+)$/);
  const propSend = path.match(/^\/api\/proposals\/(\d+)\/send$/);

  if (path === '/api/proposals/draft' && method === 'POST') {
    return draftProposal(request, env, cors);
  }
  if (path === '/api/proposals' && method === 'GET') {
    return listProposals(env, cors);
  }
  if (path === '/api/proposals' && method === 'POST') {
    return createProposal(request, env, cors);
  }
  if (propId && method === 'GET') {
    return getProposal(parseInt(propId[1]), env, cors);
  }
  if (propId && method === 'PATCH') {
    return updateProposal(parseInt(propId[1]), request, env, cors);
  }
  if (propId && method === 'DELETE') {
    return deleteProposal(parseInt(propId[1]), env, cors);
  }
  if (propSend && method === 'POST') {
    return sendProposal(parseInt(propSend[1]), env, cors);
  }

  // Messages / communication log
  if (path === '/api/messages' && method === 'GET') {
    return listMessages(env, url, cors);
  }
  if (path === '/api/messages' && method === 'POST') {
    return createMessage(request, env, cors);
  }

  // Settings (editable proposal email template, etc.)
  if (path === '/api/settings' && method === 'GET') {
    return getSettings(env, cors);
  }
  if (path === '/api/settings' && method === 'PATCH') {
    return updateSettings(request, env, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

/* ── Settings (key/value) ────────────────────────────────── */
async function getEmailTemplate(env) {
  const t = { ...EMAIL_TEMPLATE_DEFAULTS };
  if (!env.DB) return t;
  try {
    const rows = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN ('proposal_email_intro','proposal_email_closing','proposal_email_signature')`
    ).all();
    for (const r of (rows.results || [])) {
      if (r.key === 'proposal_email_intro'     && r.value) t.intro = r.value;
      if (r.key === 'proposal_email_closing'   && r.value) t.closing = r.value;
      if (r.key === 'proposal_email_signature' && r.value) t.signature = r.value;
    }
  } catch (e) { console.error('getEmailTemplate error:', e); }
  return t;
}

async function getSettings(env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const out = {};
  try {
    const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
    for (const r of (rows.results || [])) out[r.key] = r.value;
  } catch (e) { console.error('getSettings error:', e); }
  // Always return the email template (stored value or default) so the UI can show it
  const t = await getEmailTemplate(env);
  out.proposal_email_intro     = out.proposal_email_intro     ?? t.intro;
  out.proposal_email_closing   = out.proposal_email_closing   ?? t.closing;
  out.proposal_email_signature = out.proposal_email_signature ?? t.signature;
  return json(out, 200, cors);
}

async function updateSettings(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const allowed = ['proposal_email_intro', 'proposal_email_closing', 'proposal_email_signature'];
  try {
    for (const k of allowed) {
      if (body[k] === undefined) continue;
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(k, String(body[k])).run();
    }
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('updateSettings error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── Inbound email capture (Mailgun webhook) ─────────────────
   Robin BCCs log@mg.incremento.co when sending; client replies routed
   the same way. Mailgun parses and POSTs multipart/form-data here.
   We detect direction, match the contact, dedupe, and log to messages. */
const INC_SENDERS = [
  'enquiries@incremento.co',
  'contact@incremento.co',
  'robin@incremento.co',
  'hello@incremento.co',
  'robin@lumley-savile.com',
];

function extractAddress(str) {
  if (!str) return '';
  const m = String(str).match(/<([^>]+)>/);
  return (m ? m[1] : str).toLowerCase().trim();
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, '\n').trim();
}

async function handleInboundEmail(request, env, url, cors) {
  const token  = url.searchParams.get('token');
  if (!env.INBOUND_SECRET || token !== env.INBOUND_SECRET) {
    return json({ error: 'Unauthorised' }, 401, cors);
  }
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);

  // Parse Mailgun multipart/form-data (with json / urlencoded fallbacks)
  let f = {};
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      const fd = await request.formData();
      for (const [k, v] of fd.entries()) f[k] = v;
    } else if (ct.includes('application/json')) {
      f = JSON.parse(await request.text());
    } else {
      const p = new URLSearchParams(await request.text());
      for (const [k, v] of p.entries()) f[k] = v;
    }
  } catch (e) {
    return json({ error: 'Invalid payload', detail: e.message }, 400, cors);
  }

  const fromAddr = f['sender'] || f['from'] || '';
  const toAddr   = f['To'] || f['recipient'] || '';
  const subject  = f['subject'] || '(no subject)';
  let body = f['body-plain'] || f['stripped-text'] || stripHtml(f['body-html'] || '');
  if (body.length > 6000) body = body.slice(0, 6000) + '\n\n[…truncated]';

  const isOutbound  = INC_SENDERS.includes(extractAddress(fromAddr));
  const direction   = isOutbound ? 'outbound' : 'inbound';
  const clientEmail = isOutbound ? extractAddress(toAddr) : extractAddress(fromAddr);
  if (!clientEmail) return json({ error: 'Could not identify client email' }, 400, cors);
  // Ignore mail between our own addresses (e.g. admin notifications)
  if (INC_SENDERS.includes(clientEmail)) return json({ ok: true, ignored: true }, 200, cors);

  // Match latest enquiry + proposal for this contact
  let enquiry_id = null, proposal_id = null;
  try {
    const e = await env.DB.prepare('SELECT id FROM enquiries WHERE lower(email)=? ORDER BY submitted_at DESC LIMIT 1').bind(clientEmail).first();
    if (e) enquiry_id = e.id;
    const pr = await env.DB.prepare('SELECT id FROM proposals WHERE lower(client_email)=? ORDER BY created_at DESC LIMIT 1').bind(clientEmail).first();
    if (pr) proposal_id = pr.id;
  } catch {}

  // Dedupe — same sender+subject within 2 minutes
  try {
    const since = new Date(Date.now() - 120000).toISOString();
    const dup = await env.DB.prepare(
      'SELECT id FROM messages WHERE contact_email=? AND subject=? AND created_at>? LIMIT 1'
    ).bind(clientEmail, subject, since).first();
    if (dup) return json({ ok: true, duplicate: true }, 200, cors);
  } catch {}

  await logMessage(env, {
    contact_email: clientEmail, enquiry_id, proposal_id,
    direction, kind: 'mail', subject, body, source: 'email',
  });
  return json({ ok: true, direction, client: clientEmail }, 200, cors);
}

/* ── Communication log ───────────────────────────────────── */
async function logMessage(env, m) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO messages (contact_email, enquiry_id, proposal_id, direction, kind, subject, body, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      String(m.contact_email || '').toLowerCase(),
      m.enquiry_id || null,
      m.proposal_id || null,
      m.direction,
      m.kind || 'email',
      m.subject || null,
      m.body || null,
      m.source || 'system',
      new Date().toISOString()
    ).run();
  } catch (e) { console.error('logMessage error:', e); }
}

/* GET /api/messages?email=&proposal_id= — merged timeline.
   Pulls the original enquiry/enquiries for that email plus all logged
   messages, so the history is complete with no backfill. */
async function listMessages(env, url, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const email = (url.searchParams.get('email') || '').toLowerCase();
  if (!email) return json({ messages: [] }, 200, cors);

  const items = [];
  try {
    // Original enquiries from this contact (the first inbound touch)
    const enq = await env.DB.prepare(
      'SELECT id, message, submitted_at FROM enquiries WHERE lower(email) = ? ORDER BY submitted_at'
    ).bind(email).all();
    for (const e of (enq.results || [])) {
      items.push({
        direction: 'inbound', kind: 'enquiry', source: 'system',
        subject: 'Website enquiry', body: e.message,
        enquiry_id: e.id, created_at: e.submitted_at,
      });
    }
    // Logged messages
    const msgs = await env.DB.prepare(
      'SELECT * FROM messages WHERE contact_email = ? ORDER BY created_at'
    ).bind(email).all();
    for (const m of (msgs.results || [])) items.push(m);

    items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return json({ messages: items }, 200, cors);
  } catch (e) {
    console.error('listMessages error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* POST /api/messages — manually log a message Robin sent/received off-system */
async function createMessage(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  if (!b.contact_email || !b.direction) return json({ error: 'contact_email and direction required' }, 400, cors);
  await logMessage(env, {
    contact_email: b.contact_email,
    enquiry_id: b.enquiry_id,
    proposal_id: b.proposal_id,
    direction: b.direction,
    kind: 'note',
    subject: b.subject,
    body: b.body,
    source: 'manual',
  });
  return json({ ok: true }, 201, cors);
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

/* ═══════════════════════════════════════════════════════════
   PROPOSALS
   ═══════════════════════════════════════════════════════════ */

const PROPOSAL_CONTENT_SCHEMA = {
  type: 'object',
  properties: {
    title:       { type: 'string', description: 'Short proposal title, e.g. "Website Design & Build for Acme"' },
    intro:       { type: 'string', description: 'Warm 2-3 sentence opening addressed to the client, referencing their goals' },
    scope:       { type: 'array', items: {
      type: 'object',
      properties: {
        title:       { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    }, description: '3-6 workstreams describing what we will do' },
    deliverables: { type: 'array', items: { type: 'string' }, description: 'Concrete deliverables the client receives' },
    timeline:    { type: 'array', items: {
      type: 'object',
      properties: {
        phase:       { type: 'string' },
        duration:    { type: 'string', description: 'e.g. "1-2 weeks"' },
        description: { type: 'string' },
      },
      required: ['phase', 'duration', 'description'],
      additionalProperties: false,
    } },
    pricing:     { type: 'array', items: {
      type: 'object',
      properties: {
        item:        { type: 'string' },
        description: { type: 'string' },
        price:       { type: 'integer', description: 'Price in EUR, no cents' },
      },
      required: ['item', 'description', 'price'],
      additionalProperties: false,
    } },
    terms:       { type: 'string', description: 'Short paragraph: payment terms (50% upfront, 50% on delivery), validity, what is excluded' },
  },
  required: ['title', 'intro', 'scope', 'deliverables', 'timeline', 'pricing', 'terms'],
  additionalProperties: false,
};

/* ── POST /api/proposals/draft → AI-draft from enquiry ───── */
async function draftProposal(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set — run: wrangler secret put ANTHROPIC_API_KEY' }, 503, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const enquiry = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ?')
    .bind(body.enquiry_id).first();
  if (!enquiry) return json({ error: 'Enquiry not found' }, 404, cors);

  let interests = [];
  try { interests = JSON.parse(enquiry.interests || '[]'); } catch {}

  const prompt = `Draft a project proposal for this enquiry received via incremento.co:

Client name: ${enquiry.name}
Company: ${enquiry.company || 'not given'}
Interested in: ${interests.join(', ') || 'not specified'}
Their message:
"""
${enquiry.message}
"""
${enquiry.notes ? `Internal notes from Robin:\n"""\n${enquiry.notes}\n"""` : ''}
${enquiry.value > 0 ? `Robin's estimated project value: €${enquiry.value} — anchor total pricing near this.` : 'No value estimate yet — price realistically for a senior Lisbon studio (websites €2,500-€8,000, e-commerce €5,000-€15,000, AI/custom software €8,000-€30,000).'}`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: `You write client proposals for Incremento, a Lisbon digital studio in two parts: Incremento Studio (web design & digital marketing) and Incremento Labs (custom software & AI consultancy). Voice: senior, warm, confident, no fluff or buzzwords. Write in the language the client wrote in (English or European Portuguese). Scope only what the enquiry actually asks for. Prices in EUR.`,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: PROPOSAL_CONTENT_SCHEMA } },
    }),
  });

  if (!aiRes.ok) {
    const err = await aiRes.text();
    console.error('Anthropic error:', err);
    return json({ error: 'AI drafting failed', detail: err.slice(0, 500) }, 502, cors);
  }

  const aiData = await aiRes.json();
  const textBlock = (aiData.content || []).find(b => b.type === 'text');
  if (!textBlock) return json({ error: 'No content in AI response' }, 502, cors);

  let draft;
  try { draft = JSON.parse(textBlock.text); }
  catch { return json({ error: 'AI returned invalid JSON' }, 502, cors); }

  const total = (draft.pricing || []).reduce((s, p) => s + (p.price || 0), 0);

  return json({
    title: draft.title,
    content: draft,
    total_value: total,
    client_name: enquiry.name,
    client_email: enquiry.email,
    client_company: enquiry.company,
    enquiry_id: enquiry.id,
  }, 200, cors);
}

/* ── Proposal CRUD ───────────────────────────────────────── */
function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function listProposals(env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    const result = await env.DB.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200').all();
    return json({ proposals: result.results || [] }, 200, cors);
  } catch (err) {
    console.error('D1 proposals list error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

async function getProposal(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const row = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404, cors);
  return json(row, 200, cors);
}

async function createProposal(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { title, client_name, client_email, client_company, content, total_value, valid_until, enquiry_id } = body;
  if (!title || !client_name) return json({ error: 'title and client_name are required' }, 400, cors);

  const token = makeToken();
  const now = new Date().toISOString();

  try {
    const res = await env.DB.prepare(
      `INSERT INTO proposals (enquiry_id, token, title, client_name, client_email, client_company, status, content, total_value, valid_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
    ).bind(
      enquiry_id || null, token, title, client_name, client_email || null, client_company || null,
      JSON.stringify(content || {}), Number(total_value) || 0, valid_until || null, now
    ).run();
    const row = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(res.meta.last_row_id).first();
    return json(row, 201, cors);
  } catch (err) {
    console.error('D1 proposal insert error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

async function updateProposal(id, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const fields = ['title', 'client_name', 'client_email', 'client_company', 'status', 'total_value', 'valid_until'];
  const setClauses = [];
  const args = [];

  for (const f of fields) {
    if (body[f] !== undefined) { setClauses.push(`${f} = ?`); args.push(body[f]); }
  }
  if (body.content !== undefined) { setClauses.push('content = ?'); args.push(JSON.stringify(body.content)); }
  setClauses.push('updated_at = ?'); args.push(new Date().toISOString());
  args.push(id);

  try {
    await env.DB.prepare(`UPDATE proposals SET ${setClauses.join(', ')} WHERE id = ?`).bind(...args).run();
    const row = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
    return json(row || { ok: true }, 200, cors);
  } catch (err) {
    console.error('D1 proposal update error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── DELETE /api/proposals/:id → remove a proposal ──────── */
async function deleteProposal(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    await env.DB.prepare('DELETE FROM proposals WHERE id = ?').bind(id).run();
    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('D1 proposal delete error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── POST /api/proposals/:id/send → email link to client ── */
async function sendProposal(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  if (!p) return json({ error: 'Not found' }, 404, cors);
  if (!p.client_email) return json({ error: 'Proposal has no client email' }, 400, cors);

  const link = `${env.PROPOSALS_URL || 'https://enquiries.incremento.co'}/p/${p.token}`;
  const tpl  = await getEmailTemplate(env);
  const html = buildProposalEmailHtml(p, link, tpl);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:     `Robin at Incremento <${env.FROM_EMAIL}>`,
      to:       [p.client_email],
      reply_to: env.TO_EMAIL,
      subject:  `Your proposal from Incremento — ${p.title}`,
      html,
      text: `Hi ${p.client_name},\n\nYour proposal is ready: ${link}\n\nBest,\nRobin — Incremento`,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend proposal error:', err);
    return json({ error: 'Failed to send email' }, 502, cors);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE proposals SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, id).run();

  await logMessage(env, {
    contact_email: p.client_email,
    enquiry_id: p.enquiry_id,
    proposal_id: p.id,
    direction: 'outbound',
    kind: 'email',
    subject: `Your proposal from Incremento — ${p.title}`,
    body: `Sent the proposal "${p.title}" (${'€' + Number(p.total_value).toLocaleString()}). Link: ${link}`,
  });

  if (p.enquiry_id) {
    await env.DB.prepare(`UPDATE enquiries SET stage = 'proposal_sent', updated_at = ? WHERE id = ? AND stage = 'new'`)
      .bind(now, p.enquiry_id).run();
  }

  const row = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  return json(row, 200, cors);
}

/* ── POST /p/:token/accept (public) ──────────────────────── */
/* A proposal is expired if it has a valid_until date in the past and
   hasn't already been accepted. */
function isExpired(p) {
  if (!p.valid_until || p.status === 'accepted') return false;
  const d = new Date(String(p.valid_until).slice(0, 10) + 'T23:59:59');
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}

async function acceptProposal(token, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE token = ?').bind(token).first();
  if (!p) return json({ error: 'Not found' }, 404, cors);
  if (p.status === 'accepted') return json({ ok: true, already: true }, 200, cors);
  if (p.status === 'declined')  return json({ error: 'This proposal was declined.' }, 409, cors);
  if (isExpired(p))             return json({ error: 'This proposal has expired. Please ask for an updated one.' }, 410, cors);

  let body = {};
  try { body = await request.json(); } catch {}
  const signedName = String(body.signed_name || '').trim().slice(0, 120);
  if (signedName.length < 2) return json({ error: 'Please type your full name to sign.' }, 400, cors);

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE proposals SET status = 'accepted', accepted_at = ?, signed_name = ?, updated_at = ? WHERE id = ?`)
    .bind(now, signedName, now, p.id).run();

  if (p.enquiry_id) {
    await env.DB.prepare(`UPDATE enquiries SET stage = 'accepted', updated_at = ? WHERE id = ?`)
      .bind(now, p.enquiry_id).run();
  }

  await logMessage(env, {
    contact_email: p.client_email,
    enquiry_id: p.enquiry_id,
    proposal_id: p.id,
    direction: 'inbound',
    kind: 'accepted',
    subject: 'Proposal accepted',
    body: `${p.client_name} accepted "${p.title}" (signed: ${signedName}).`,
  });

  // Notify Robin
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `Incremento Proposals <${env.FROM_EMAIL}>`,
        to: [env.TO_EMAIL],
        subject: `🎉 Proposal accepted: ${p.title} — ${p.client_name}`,
        text: `${p.client_name}${p.client_company ? ` (${p.client_company})` : ''} accepted "${p.title}" (€${Number(p.total_value).toLocaleString()}).\n\nSigned by: ${signedName}\nAccepted at: ${now}`,
      }),
    });
  } catch (e) { console.error('Accept notify error:', e); }

  return json({ ok: true }, 200, cors);
}

/* ── POST /p/:token/decline (public) → client declines ───── */
async function declineProposal(token, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE token = ?').bind(token).first();
  if (!p) return json({ error: 'Not found' }, 404, cors);
  if (p.status === 'accepted') return json({ error: 'This proposal was already accepted.' }, 409, cors);
  if (p.status === 'declined') return json({ ok: true, already: true }, 200, cors);

  let body = {};
  try { body = await request.json(); } catch {}
  const reason = String(body.reason || '').trim().slice(0, 1000);
  const now = new Date().toISOString();

  await env.DB.prepare(`UPDATE proposals SET status = 'declined', declined_at = ?, decline_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(now, reason || null, now, p.id).run();

  await logMessage(env, {
    contact_email: p.client_email,
    enquiry_id: p.enquiry_id,
    proposal_id: p.id,
    direction: 'inbound',
    kind: 'declined',
    subject: 'Proposal declined',
    body: `${p.client_name} declined "${p.title}".${reason ? ' Reason: ' + reason : ''}`,
  });

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `Incremento Proposals <${env.FROM_EMAIL}>`,
        to: [env.TO_EMAIL],
        subject: `Proposal declined: ${p.title} — ${p.client_name}`,
        text: `${p.client_name}${p.client_company ? ` (${p.client_company})` : ''} declined "${p.title}".${reason ? `\n\nReason: ${reason}` : ''}\n\nDeclined at: ${now}`,
      }),
    });
  } catch (e) { console.error('Decline notify error:', e); }

  return json({ ok: true }, 200, cors);
}

/* ── GET /p/:token (public) → branded proposal page ──────── */
async function renderProposalPage(token, env, url) {
  if (!env.DB) return new Response('Service unavailable', { status: 503 });
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE token = ?').bind(token).first();
  const isPdf   = url && url.searchParams.get('pdf') === '1';
  const preview = (url && url.searchParams.get('preview') === '1') || isPdf;  // pdf is an admin action too
  if (!p || (p.status === 'draft' && !preview)) return new Response('Proposal not found', { status: 404 });

  // Record first view (never in preview mode — that's the admin looking)
  if (!p.viewed_at && !preview) {
    const now = new Date().toISOString();
    const newStatus = p.status === 'sent' ? 'viewed' : p.status;
    await env.DB.prepare(`UPDATE proposals SET viewed_at = ?, status = ?, updated_at = ? WHERE id = ?`)
      .bind(now, newStatus, now, p.id).run();
    p.status = newStatus;
  }

  let c = {};
  try { c = JSON.parse(p.content || '{}'); } catch {}

  const eur = n => '€' + Number(n || 0).toLocaleString('en-IE');
  const accepted = p.status === 'accepted';
  const declined = p.status === 'declined';
  const expired  = isExpired(p) && !preview;
  const fmtDate  = d => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const previewBanner = preview
    ? `<div class="no-print" style="position:sticky;top:0;z-index:10;background:#f59e0b;color:#0a1219;text-align:center;font-weight:700;font-size:0.82rem;padding:9px 16px;font-family:'Space Grotesk',sans-serif;letter-spacing:0.04em">PREVIEW — this is how your client will see it${p.status === 'draft' ? ' (not sent yet)' : ''}</div>`
    : '';

  const scopeHtml = (c.scope || []).map((s, i) => `
    <div class="scope-item">
      <div class="scope-num">${String(i + 1).padStart(2, '0')}</div>
      <div><h3>${escHtml(s.title)}</h3><p>${escHtml(s.description)}</p></div>
    </div>`).join('');

  const delivHtml = (c.deliverables || []).map(d => `<li>${escHtml(d)}</li>`).join('');

  const timeHtml = (c.timeline || []).map(t => `
    <div class="time-row">
      <div class="time-phase">${escHtml(t.phase)}</div>
      <div class="time-dur">${escHtml(t.duration)}</div>
      <div class="time-desc">${escHtml(t.description)}</div>
    </div>`).join('');

  const priceHtml = (c.pricing || []).map(pr => `
    <tr><td><strong>${escHtml(pr.item)}</strong><br><span class="price-desc">${escHtml(pr.description)}</span></td>
    <td class="price-amt">${eur(pr.price)}</td></tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escHtml(p.title)} — Incremento</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a1219;--surface:#0e1820;--surface2:#152332;--border:rgba(255,255,255,0.07);--text:#e0e8f0;--dim:#8fa3b3;--lime:#9EF54A;--cyan:#5EE7D8}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;line-height:1.7;font-size:16px}
h1,h2,h3{font-family:'Space Grotesk',sans-serif;letter-spacing:-0.02em}
.wrap{max-width:780px;margin:0 auto;padding:48px 24px 80px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:48px}
.brand span{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:1.2rem}
.brand .dot{color:var(--lime)}
.eyebrow{font-size:0.72rem;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:var(--cyan);margin-bottom:10px}
h1{font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.15;margin-bottom:14px}
.meta{color:var(--dim);font-size:0.9rem;margin-bottom:8px}
.intro{font-size:1.08rem;color:var(--dim);margin:28px 0 0;border-left:3px solid var(--lime);padding-left:20px}
section{margin-top:56px}
h2{font-size:1.35rem;margin-bottom:24px}
h2 .accent{background:linear-gradient(135deg,var(--lime),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
.scope-item{display:flex;gap:18px;padding:18px 0;border-bottom:1px solid var(--border)}
.scope-num{font-family:'Space Grotesk',sans-serif;font-weight:700;color:var(--lime);font-size:0.95rem;min-width:30px;padding-top:3px}
.scope-item h3{font-size:1.02rem;margin-bottom:4px}
.scope-item p{color:var(--dim);font-size:0.92rem}
ul.deliv{list-style:none}
ul.deliv li{padding:9px 0 9px 28px;position:relative;border-bottom:1px solid var(--border);font-size:0.95rem}
ul.deliv li:before{content:"";position:absolute;left:2px;top:17px;width:14px;height:14px;background:linear-gradient(135deg,var(--lime),var(--cyan));clip-path:polygon(14% 44%,0 60%,40% 100%,100% 16%,84% 4%,38% 72%);}
.time-row{display:grid;grid-template-columns:160px 90px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);font-size:0.92rem}
.time-phase{font-weight:600;font-family:'Space Grotesk',sans-serif}
.time-dur{color:var(--lime);font-size:0.82rem;font-weight:500}
.time-desc{color:var(--dim)}
@media(max-width:560px){.time-row{grid-template-columns:1fr;gap:2px}}
table.pricing{width:100%;border-collapse:collapse;margin-top:6px}
table.pricing td{padding:14px 0;border-bottom:1px solid var(--border);vertical-align:top;font-size:0.94rem}
.price-desc{color:var(--dim);font-size:0.85rem}
.price-amt{text-align:right;font-family:'Space Grotesk',sans-serif;font-weight:600;white-space:nowrap;padding-left:20px}
.total-row{display:flex;justify-content:space-between;align-items:center;margin-top:18px;padding:18px 22px;background:var(--surface2);border-radius:12px;border:1px solid var(--border)}
.total-row .lbl{font-size:0.8rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--dim)}
.total-row .amt{font-family:'Space Grotesk',sans-serif;font-size:1.5rem;font-weight:700;background:linear-gradient(135deg,var(--lime),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
.terms{color:var(--dim);font-size:0.88rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 24px}
.cta{margin-top:56px;text-align:center;padding:40px 24px;background:var(--surface);border:1px solid var(--border);border-radius:16px}
.btn-accept{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,var(--lime),var(--cyan));color:#0a1219;font-weight:700;font-size:1rem;padding:15px 36px;border-radius:10px;border:none;cursor:pointer;font-family:'Space Grotesk',sans-serif;letter-spacing:-0.01em}
.btn-accept:disabled{opacity:0.6;cursor:default}
.btn-pdf{display:inline-flex;align-items:center;gap:7px;margin-left:14px;background:none;border:1px solid var(--border);color:var(--dim);padding:14px 22px;border-radius:10px;cursor:pointer;font-size:0.88rem;font-family:'Inter',sans-serif}
.accepted-badge{display:inline-flex;align-items:center;gap:8px;color:var(--lime);font-weight:600;font-family:'Space Grotesk',sans-serif;font-size:1.05rem}
.cta p{color:var(--dim);font-size:0.85rem;margin-top:14px}
footer{margin-top:64px;text-align:center;color:var(--dim);font-size:0.8rem}
footer a{color:var(--cyan);text-decoration:none}
@media print{
  html,body{background:var(--bg)!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .btn-accept,.btn-pdf,.no-print,.cta{display:none!important}
  .wrap{max-width:100%;padding:32px 40px 60px}
  @page{margin:0;size:A4}
}
</style>
</head>
<body>
${previewBanner}
<div class="wrap">
  <div class="brand">
    <svg width="30" height="30" viewBox="0 0 32 32" fill="none"><defs><linearGradient id="g" x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#9EF54A"/><stop offset="100%" stop-color="#5EE7D8"/></linearGradient></defs><rect x="4" y="20" width="5" height="8" rx="2.5" fill="url(#g)" opacity="0.55"/><rect x="12" y="14" width="5" height="14" rx="2.5" fill="url(#g)" opacity="0.78"/><rect x="20" y="10" width="5" height="18" rx="2.5" fill="url(#g)"/><circle cx="22.5" cy="5.5" r="2.25" fill="url(#g)"/></svg>
    <span>incremento<span class="dot">.</span></span>
  </div>

  <p class="eyebrow">Project proposal</p>
  <h1>${escHtml(p.title)}</h1>
  <p class="meta">Prepared for ${escHtml(p.client_name)}${p.client_company ? ' · ' + escHtml(p.client_company) : ''}</p>
  <p class="meta">${new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}${p.valid_until ? ' · Valid until ' + new Date(p.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</p>

  ${c.intro ? `<p class="intro">${escHtml(c.intro)}</p>` : ''}

  ${scopeHtml ? `<section><h2>Scope of <span class="accent">work</span></h2>${scopeHtml}</section>` : ''}
  ${delivHtml ? `<section><h2>What you'll <span class="accent">receive</span></h2><ul class="deliv">${delivHtml}</ul></section>` : ''}
  ${timeHtml ? `<section><h2><span class="accent">Timeline</span></h2>${timeHtml}</section>` : ''}
  ${priceHtml ? `<section><h2>Investment</h2><table class="pricing">${priceHtml}</table>
    <div class="total-row"><span class="lbl">Total</span><span class="amt">${eur(p.total_value)}</span></div></section>` : ''}
  ${c.terms ? `<section><h2>Terms</h2><div class="terms">${escHtml(c.terms)}</div></section>` : ''}

  <div class="cta">
    ${accepted
      ? `<span class="accepted-badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Proposal accepted — thank you!</span>
         ${p.signed_name ? `<p>Signed by <strong style="color:var(--text)">${escHtml(p.signed_name)}</strong>${p.accepted_at ? ' on ' + fmtDate(p.accepted_at) : ''}.</p>` : ''}
         <p>We'll be in touch shortly to kick things off.</p>
         <button class="btn-pdf" style="margin-left:0" onclick="downloadPdf(this)">Download PDF</button>`
      : declined
      ? `<span style="color:var(--dim);font-size:1rem;font-weight:600">This proposal has been declined.</span>
         <p>Changed your mind? Just reply to the email this came with and we'll sort it out.</p>`
      : expired
      ? `<span style="color:#f59e0b;font-weight:700;font-size:1rem">This proposal has expired${p.valid_until ? ' (it was valid until ' + fmtDate(p.valid_until) + ')' : ''}.</span>
         <p>Still interested? Reply to the email this came with and we'll send you a fresh one.</p>
         <button class="btn-pdf" style="margin-left:0" onclick="downloadPdf(this)">Download PDF</button>`
      : preview
      ? `<span style="color:var(--dim);font-size:0.9rem;display:block;margin-bottom:18px">The client will see a <strong style="color:var(--lime)">signature + Accept</strong> form here (and a Decline option).</span>
         <button class="btn-pdf" style="margin-left:0" onclick="downloadPdf(this)">Download PDF</button>`
      : `<div style="max-width:440px;margin:0 auto">
           <label style="display:block;font-size:0.8rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--cyan);margin-bottom:10px">Sign to accept</label>
           <input id="sig-name" type="text" autocomplete="name" placeholder="Type your full name" style="width:100%;padding:13px 16px;border-radius:9px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:1rem;margin-bottom:14px">
           <label style="display:flex;gap:10px;align-items:flex-start;font-size:0.86rem;color:var(--dim);text-align:left;margin-bottom:6px;cursor:pointer"><input type="checkbox" id="agree" style="margin-top:4px;flex:0 0 auto"> <span>I agree to the scope, timeline and terms set out above.</span></label>
           <div id="accept-err" style="color:#ff8a8a;font-size:0.84rem;min-height:18px;margin:6px 0 8px"></div>
           <button class="btn-accept" id="accept-btn" onclick="acceptIt()">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
             Accept this proposal
           </button>
           <button class="btn-pdf" onclick="downloadPdf(this)">Download PDF</button>
           <div><button onclick="declineIt()" id="decline-btn" style="background:none;border:none;color:var(--dim);text-decoration:underline;cursor:pointer;font-size:0.84rem;margin-top:18px;font-family:inherit">Decline this proposal</button></div>
           <p style="margin-top:14px">Questions? Just reply to the email this came with.</p>
         </div>`}
  </div>

  <footer>
    <p>incremento<span style="color:var(--lime)">.</span> — Lisbon · <a href="https://incremento.co">incremento.co</a></p>
  </footer>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
<script>
const PDF_NAME = ${JSON.stringify('Incremento Proposal — ' + (p.title || 'Untitled') + '.pdf')};

async function downloadPdf(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing PDF…'; }
  const hide = [...document.querySelectorAll('.no-print, .cta')];
  hide.forEach(el => el.style.display = 'none');
  // Capture-only overrides: force the dark background onto the element we render
  // (the page bg lives on <body>, not .wrap), and flatten gradient-clipped text
  // to solid lime — html2canvas can't render background-clip:text.
  const pdfStyle = document.createElement('style');
  pdfStyle.textContent =
    '.wrap{background:#0a1219 !important}' +
    'h1 .accent,h2 .accent,.text-gradient,.total-row .amt{' +
      'background:none !important;-webkit-background-clip:border-box !important;' +
      'background-clip:border-box !important;-webkit-text-fill-color:#9EF54A !important;' +
      'color:#9EF54A !important}';
  document.head.appendChild(pdfStyle);
  try {
    await html2pdf().set({
      margin: 0,
      filename: PDF_NAME,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, backgroundColor: '#0a1219', useCORS: true },
      jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.scope-item', '.time-row', 'tr', '.total-row'] },
    }).from(document.querySelector('.wrap')).save();
  } catch (e) { alert('PDF generation failed — try the print dialog instead (Cmd+P).'); }
  pdfStyle.remove();
  hide.forEach(el => el.style.display = '');
  if (btn) { btn.disabled = false; btn.textContent = 'Download PDF'; }
}

if (new URLSearchParams(location.search).get('pdf') === '1') {
  window.addEventListener('load', () => setTimeout(() => downloadPdf(), 600));
}

async function acceptIt() {
  const err = document.getElementById('accept-err');
  const name = (document.getElementById('sig-name').value || '').trim();
  const agree = document.getElementById('agree').checked;
  err.textContent = '';
  if (name.length < 2) { err.textContent = 'Please type your full name to sign.'; return; }
  if (!agree) { err.textContent = 'Please tick the box to agree to the terms.'; return; }
  const btn = document.getElementById('accept-btn');
  btn.disabled = true; btn.textContent = 'Accepting…';
  try {
    const res = await fetch(location.pathname + '/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signed_name: name }),
    });
    if (res.ok) { location.reload(); }
    else { const d = await res.json().catch(() => ({})); err.textContent = d.error || 'Something went wrong.'; btn.disabled = false; btn.textContent = 'Try again'; }
  } catch { err.textContent = 'Network error — please try again.'; btn.disabled = false; btn.textContent = 'Try again'; }
}

async function declineIt() {
  if (!confirm('Decline this proposal?')) return;
  const reason = prompt('Optional — let us know why (helps us improve). Leave blank to skip.') || '';
  const btn = document.getElementById('decline-btn');
  btn.disabled = true; btn.textContent = 'Declining…';
  try {
    const res = await fetch(location.pathname + '/decline', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason }),
    });
    if (res.ok) { location.reload(); }
    else { btn.disabled = false; btn.textContent = 'Decline this proposal'; }
  } catch { btn.disabled = false; btn.textContent = 'Decline this proposal'; }
}
</script>
</body>
</html>`;

  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ── Proposal email to client ────────────────────────────── */
const EMAIL_TEMPLATE_DEFAULTS = {
  intro:     'Thanks for getting in touch — your proposal for {title} is ready. It covers the scope, timeline and investment, and you can accept it online with one click.',
  closing:   'Any questions at all, just hit reply — happy to walk you through it.',
  signature: 'Robin\nIncremento · Lisbon',
};

function fillTokens(str, p) {
  return String(str || '')
    .replace(/\{name\}/g, escHtml(p.client_name || 'there'))
    .replace(/\{title\}/g, `<strong style="color:#e0e8f0">${escHtml(p.title || '')}</strong>`)
    .replace(/\{company\}/g, escHtml(p.client_company || ''));
}
function nl2br(str) { return escHtml(str).replace(/\n/g, '<br>'); }

function buildProposalEmailHtml(p, link, tpl = {}) {
  const t = { ...EMAIL_TEMPLATE_DEFAULTS, ...tpl };
  const sigLines = String(t.signature || '').split('\n');
  const sigHtml = sigLines.length > 1
    ? `${escHtml(sigLines[0])}<br><span style="color:#8fa3b3;font-size:12px">${escHtml(sigLines.slice(1).join(' · '))}</span>`
    : escHtml(t.signature);
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0f14;font-family:Inter,ui-sans-serif,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f14;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#0e1820;border-radius:12px;overflow:hidden;max-width:600px;width:100%;border:1px solid rgba(255,255,255,0.06)">
        <tr>
          <td style="padding:28px 36px;background:linear-gradient(135deg,#9EF54A,#5EE7D8);text-align:center">
            <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#0a1219">Your proposal from</p>
            <p style="margin:5px 0 0;font-size:22px;font-weight:700;color:#0a1219;letter-spacing:-0.02em;font-family:'Space Grotesk',sans-serif">incremento<span style="opacity:0.7">.</span></p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px">
            <p style="margin:0 0 14px;font-size:16px;color:#e0e8f0">Hi ${escHtml(p.client_name)},</p>
            <p style="margin:0 0 22px;font-size:15px;color:#b0bec8;line-height:1.7">${fillTokens(t.intro, p)}</p>
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 26px">
              <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#9EF54A,#5EE7D8);color:#0a1219;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:-0.01em">View your proposal →</a>
            </td></tr></table>
            <p style="margin:0;font-size:13px;color:#8fa3b3;line-height:1.7">${fillTokens(t.closing, p)}</p>
            <p style="margin:18px 0 0;font-size:14px;color:#e0e8f0">${sigHtml}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px;border-top:1px solid rgba(255,255,255,0.06);text-align:center">
            <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.25)"><a href="https://incremento.co" style="color:rgba(255,255,255,0.35);text-decoration:none">incremento.co</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
