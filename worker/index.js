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
  if (idMatch && method === 'DELETE') {
    return deleteEnquiry(parseInt(idMatch[1]), env, cors);
  }
  if (path === '/api/stats' && method === 'GET') {
    return getStats(env, cors);
  }

  // Triage — pending inbound submissions awaiting a new-deal / merge / dismiss decision
  if (path === '/api/triage' && method === 'GET') return listTriage(env, cors);
  const triageMatch = path.match(/^\/api\/triage\/(\d+)\/(accept|merge|dismiss)$/);
  if (triageMatch && method === 'POST') {
    const tid = parseInt(triageMatch[1]);
    if (triageMatch[2] === 'accept')  return triageAccept(tid, env, cors);
    if (triageMatch[2] === 'merge')   return triageMerge(tid, request, env, cors);
    if (triageMatch[2] === 'dismiss') return triageDismiss(tid, env, cors);
  }

  // Proposals
  const propId   = path.match(/^\/api\/proposals\/(\d+)$/);
  const propSend = path.match(/^\/api\/proposals\/(\d+)\/send$/);
  const propPrev = path.match(/^\/api\/proposals\/(\d+)\/send-preview$/);

  if (path === '/api/proposals/draft' && method === 'POST') {
    return draftProposal(request, env, cors);
  }
  if (path === '/api/proposals' && method === 'GET') {
    return listProposals(env, url, cors);
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
  if (propPrev && method === 'GET') {
    return previewProposalEmail(parseInt(propPrev[1]), env, cors);
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

  // Proposal component library (reusable building blocks)
  const blockId = path.match(/^\/api\/proposal-blocks\/(\d+)$/);
  if (path === '/api/proposal-blocks' && method === 'GET')  return listBlocks(env, cors);
  if (path === '/api/proposal-blocks' && method === 'POST') return createBlock(request, env, cors);
  if (blockId && method === 'PATCH')  return updateBlock(parseInt(blockId[1]), request, env, cors);
  if (blockId && method === 'DELETE') return deleteBlock(parseInt(blockId[1]), env, cors);

  // Proposal structure (ordered sections of a proposal document)
  const sectionId = path.match(/^\/api\/proposal-sections\/(\d+)$/);
  if (path === '/api/proposal-sections' && method === 'GET')  return listSections(env, cors);
  if (path === '/api/proposal-sections' && method === 'POST') return createSection(request, env, cors);
  if (sectionId && method === 'PATCH')  return updateSection(parseInt(sectionId[1]), request, env, cors);
  if (sectionId && method === 'DELETE') return deleteSection(parseInt(sectionId[1]), env, cors);

  // Contacts (people on a deal)
  const contactId = path.match(/^\/api\/contacts\/(\d+)$/);
  if (path === '/api/companies' && method === 'GET') return listCompanies(env, cors);
  if (path === '/api/contacts' && method === 'GET')  return listContacts(env, url, cors);
  if (path === '/api/contacts' && method === 'POST') return createContact(request, env, cors);
  if (contactId && method === 'PATCH')  return updateContact(parseInt(contactId[1]), request, env, cors);
  if (contactId && method === 'DELETE') return deleteContact(parseInt(contactId[1]), env, cors);

  // Team + deal assignees
  const asgMatch = path.match(/^\/api\/enquiries\/(\d+)\/assignees$/);
  if (path === '/api/team' && method === 'GET') return listTeam(env, cors);
  if (asgMatch && method === 'GET')  return listAssignees(parseInt(asgMatch[1]), env, cors);
  if (asgMatch && method === 'POST') return setAssignees(parseInt(asgMatch[1]), request, env, cors);

  // Send an email to a contact (from a chosen incremento.co address, with signature, logged)
  if (path === '/api/send-email' && method === 'POST') return sendEmail(request, env, cors);

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
const EMAIL_FIELDS = ['greeting', 'intro', 'closing', 'signature'];
function normLang(l) { return l === 'pt' ? 'pt' : 'en'; }

// The client's chosen language picks the template set; each field can be overridden in settings.
async function getEmailTemplate(env, lang) {
  lang = normLang(lang);
  const t = { ...(EMAIL_TEMPLATE_DEFAULTS[lang] || EMAIL_TEMPLATE_DEFAULTS.en) };
  if (!env.DB) return t;
  try {
    const keys = EMAIL_FIELDS.map(f => `'proposal_email_${f}_${lang}'`).join(',');
    const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${keys})`).all();
    for (const r of (rows.results || [])) {
      for (const f of EMAIL_FIELDS) {
        if (r.key === `proposal_email_${f}_${lang}` && r.value) t[f] = r.value;
      }
    }
  } catch (e) { console.error('getEmailTemplate error:', e); }
  return t;
}

// Editable "Why Incremento" prose for the proposal page, per language.
// Falls back to the PROP_LABELS defaults when not overridden in settings.
const WHY_FIELDS = ['why_text', 'why_ledby_heading', 'why_ledby_text'];
async function getWhyContent(env, lang) {
  lang = normLang(lang);
  const L = PROP_LABELS[lang] || PROP_LABELS.en;
  const out = { why_text: L.whyText, why_ledby_heading: L.ledBy, why_ledby_text: L.ledByText };
  if (!env.DB) return out;
  try {
    const keys = WHY_FIELDS.map(f => `'proposal_${f}_${lang}'`).join(',');
    const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${keys})`).all();
    for (const r of (rows.results || [])) {
      for (const f of WHY_FIELDS) { if (r.key === `proposal_${f}_${lang}` && r.value) out[f] = r.value; }
    }
  } catch (e) { console.error('getWhyContent error:', e); }
  return out;
}

async function getSettings(env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const out = {};
  try {
    const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
    for (const r of (rows.results || [])) out[r.key] = r.value;
  } catch (e) { console.error('getSettings error:', e); }
  // Always return the email template (stored value or default), per language, so the UI can show it
  for (const lang of ['en', 'pt']) {
    const t = await getEmailTemplate(env, lang);
    for (const f of EMAIL_FIELDS) {
      const k = `proposal_email_${f}_${lang}`;
      out[k] = out[k] ?? t[f];
    }
    const w = await getWhyContent(env, lang);
    for (const f of WHY_FIELDS) {
      const k = `proposal_${f}_${lang}`;
      out[k] = out[k] ?? w[f];
    }
  }
  return json(out, 200, cors);
}

async function updateSettings(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const allowed = ['en', 'pt'].flatMap(lang => [
    ...EMAIL_FIELDS.map(f => `proposal_email_${f}_${lang}`),
    ...WHY_FIELDS.map(f => `proposal_${f}_${lang}`),
  ]);
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
  const eid = url.searchParams.get('enquiry_id');
  const emailParam = (url.searchParams.get('email') || '').toLowerCase();

  const items = [];
  try {
    let emails = [];          // every email address that belongs to this thread
    let enquiryRows = [];      // enquiry rows whose original message opens the thread

    if (eid) {
      // Deal mode: span the enquiry's own email + every contact on the deal
      const e = await env.DB.prepare(
        'SELECT id, email, message, submitted_at FROM enquiries WHERE id = ?'
      ).bind(parseInt(eid)).first();
      if (e) { enquiryRows.push(e); if (e.email) emails.push(e.email.toLowerCase()); }
      const cts = await env.DB.prepare(
        'SELECT email FROM contacts WHERE enquiry_id = ? AND email IS NOT NULL'
      ).bind(parseInt(eid)).all();
      for (const c of (cts.results || [])) if (c.email) emails.push(c.email.toLowerCase());
    } else if (emailParam) {
      // Contact mode: single email address
      emails.push(emailParam);
      const enq = await env.DB.prepare(
        'SELECT id, email, message, submitted_at FROM enquiries WHERE lower(email) = ? ORDER BY submitted_at'
      ).bind(emailParam).all();
      enquiryRows = enq.results || [];
    } else {
      return json({ messages: [] }, 200, cors);
    }

    emails = [...new Set(emails)];

    // Original enquiry message(s) — the first inbound touch
    for (const e of enquiryRows) {
      items.push({
        direction: 'inbound', kind: 'enquiry', source: 'system',
        subject: 'Website enquiry', body: e.message,
        enquiry_id: e.id, created_at: e.submitted_at,
      });
    }

    // Logged messages: matched by this deal's id OR any of its contact emails
    const conds = [], binds = [];
    if (eid) { conds.push('enquiry_id = ?'); binds.push(parseInt(eid)); }
    if (emails.length) {
      conds.push('contact_email IN (' + emails.map(() => '?').join(',') + ')');
      binds.push(...emails);
    }
    if (conds.length) {
      const msgs = await env.DB.prepare(
        'SELECT * FROM messages WHERE ' + conds.join(' OR ') + ' ORDER BY created_at'
      ).bind(...binds).all();
      const seen = new Set();
      for (const m of (msgs.results || [])) {
        if (m.id != null) { if (seen.has(m.id)) continue; seen.add(m.id); }
        items.push(m);
      }
    }

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

/* GET /api/companies — distinct company names (+ a representative URL) for the deal picker */
async function listCompanies(env, cors) {
  if (!env.DB) return json({ companies: [] }, 200, cors);
  try {
    const r = await env.DB.prepare(
      `SELECT company, MAX(company_url) AS url
         FROM enquiries
        WHERE company IS NOT NULL AND TRIM(company) <> ''
        GROUP BY company
        ORDER BY company COLLATE NOCASE`
    ).all();
    return json({ companies: r.results || [] }, 200, cors);
  } catch (e) {
    console.error('listCompanies error:', e);
    return json({ companies: [] }, 200, cors);
  }
}

/* ── Proposal component library ──────────────────────────────
   Reusable building blocks Robin can drop into any proposal.
   kind ∈ intro | scope | deliverable | timeline | pricing | terms      */
async function listBlocks(env, cors) {
  if (!env.DB) return json({ blocks: [] }, 200, cors);
  try {
    const r = await env.DB.prepare(
      'SELECT * FROM proposal_blocks ORDER BY service, id'
    ).all();
    return json({ blocks: r.results || [] }, 200, cors);
  } catch (e) {
    console.error('listBlocks error:', e);
    return json({ blocks: [] }, 200, cors);
  }
}

async function createBlock(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const kind = (b.kind || '').trim();
  const title = (b.title || '').trim();
  if (!kind || !title) return json({ error: 'kind and title required' }, 400, cors);
  try {
    const r = await env.DB.prepare(
      `INSERT INTO proposal_blocks (kind, service, section_id, title, body, price, extra, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      kind, b.service || null,
      (b.section_id === '' || b.section_id == null) ? null : Number(b.section_id) || null,
      title, b.body || null,
      (b.price === '' || b.price == null) ? null : Number(b.price) || 0,
      b.extra || null, new Date().toISOString()
    ).run();
    return json({ ok: true, id: r.meta ? r.meta.last_row_id : null }, 201, cors);
  } catch (e) {
    console.error('createBlock error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

async function updateBlock(id, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const sets = [], args = [];
  if (b.title   !== undefined) { sets.push('title = ?');   args.push(b.title); }
  if (b.body    !== undefined) { sets.push('body = ?');    args.push(b.body); }
  if (b.extra   !== undefined) { sets.push('extra = ?');   args.push(b.extra); }
  if (b.service !== undefined) { sets.push('service = ?'); args.push(b.service || null); }
  if (b.section_id !== undefined) { sets.push('section_id = ?'); args.push((b.section_id === '' || b.section_id == null) ? null : Number(b.section_id) || null); }
  if (b.price   !== undefined) { sets.push('price = ?');   args.push((b.price === '' || b.price == null) ? null : Number(b.price) || 0); }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400, cors);
  args.push(id);
  try {
    await env.DB.prepare(`UPDATE proposal_blocks SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('updateBlock error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

async function deleteBlock(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    await env.DB.prepare('DELETE FROM proposal_blocks WHERE id = ?').bind(id).run();
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('deleteBlock error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── Proposal structure: ordered sections ─────────────────── */
async function listSections(env, cors) {
  if (!env.DB) return json({ sections: [] }, 200, cors);
  try {
    const r = await env.DB.prepare(
      'SELECT * FROM proposal_sections ORDER BY position, id'
    ).all();
    return json({ sections: r.results || [] }, 200, cors);
  } catch (e) {
    console.error('listSections error:', e);
    return json({ sections: [] }, 200, cors);
  }
}

async function createSection(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const title = (b.title || '').trim();
  if (!title) return json({ error: 'title required' }, 400, cors);
  try {
    // Default to the end of the list unless a position is given
    let pos = b.position;
    if (pos == null) {
      const mx = await env.DB.prepare('SELECT MAX(position) AS m FROM proposal_sections').first();
      pos = ((mx && mx.m) || 0) + 1;
    }
    const r = await env.DB.prepare(
      `INSERT INTO proposal_sections (position, title, description, shared_content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(Number(pos) || 0, title, b.description || null, b.shared_content || null, new Date().toISOString()).run();
    return json({ ok: true, id: r.meta ? r.meta.last_row_id : null }, 201, cors);
  } catch (e) {
    console.error('createSection error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

async function updateSection(id, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const sets = [], args = [];
  if (b.title          !== undefined) { sets.push('title = ?');          args.push(b.title); }
  if (b.description    !== undefined) { sets.push('description = ?');    args.push(b.description || null); }
  if (b.shared_content !== undefined) { sets.push('shared_content = ?'); args.push(b.shared_content || null); }
  if (b.position       !== undefined) { sets.push('position = ?');       args.push(Number(b.position) || 0); }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400, cors);
  args.push(id);
  try {
    await env.DB.prepare(`UPDATE proposal_sections SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('updateSection error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

async function deleteSection(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    // Refuse to delete a section that still has components attached
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM proposal_blocks WHERE section_id = ?').bind(id).first();
    const n = (cnt && cnt.n) || 0;
    if (n > 0) {
      return json({ error: 'has_components', count: n,
        message: `This section still has ${n} component${n===1?'':'s'} attached. Move or delete them first.` }, 409, cors);
    }
    await env.DB.prepare('DELETE FROM proposal_sections WHERE id = ?').bind(id).run();
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('deleteSection error:', e);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── Contacts (people on a deal) ─────────────────────────── */
async function listContacts(env, url, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const eid = url.searchParams.get('enquiry_id');
  try {
    const q = eid
      ? env.DB.prepare('SELECT * FROM contacts WHERE enquiry_id = ? ORDER BY is_primary DESC, id').bind(parseInt(eid))
      : env.DB.prepare('SELECT * FROM contacts ORDER BY id DESC');
    const r = await q.all();
    return json({ contacts: r.results || [] }, 200, cors);
  } catch (e) { console.error('listContacts', e); return json({ error: 'Database error' }, 500, cors); }
}

async function createContact(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  if (!b.name) return json({ error: 'name required' }, 400, cors);
  try {
    const res = await env.DB.prepare(
      'INSERT INTO contacts (enquiry_id,name,email,role,phone,is_primary,created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(b.enquiry_id || null, b.name, b.email || null, b.role || null, b.phone || null, b.is_primary ? 1 : 0, new Date().toISOString()).run();
    const row = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(res.meta.last_row_id).first();
    return json(row, 201, cors);
  } catch (e) { console.error('createContact', e); return json({ error: 'Database error' }, 500, cors); }
}

async function updateContact(id, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const fields = ['name', 'email', 'role', 'phone', 'is_primary'];
  const set = [], args = [];
  for (const f of fields) if (b[f] !== undefined) { set.push(`${f} = ?`); args.push(f === 'is_primary' ? (b[f] ? 1 : 0) : b[f]); }
  if (!set.length) return json({ error: 'Nothing to update' }, 400, cors);
  args.push(id);
  try {
    await env.DB.prepare(`UPDATE contacts SET ${set.join(', ')} WHERE id = ?`).bind(...args).run();
    const row = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
    return json(row || { ok: true }, 200, cors);
  } catch (e) { console.error('updateContact', e); return json({ error: 'Database error' }, 500, cors); }
}

async function deleteContact(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try { await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run(); return json({ ok: true }, 200, cors); }
  catch (e) { console.error('deleteContact', e); return json({ error: 'Database error' }, 500, cors); }
}

/* ── Team + deal assignees ───────────────────────────────── */
async function listTeam(env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try { const r = await env.DB.prepare('SELECT * FROM team_members WHERE active = 1 ORDER BY id').all(); return json({ team: r.results || [] }, 200, cors); }
  catch (e) { console.error('listTeam', e); return json({ error: 'Database error' }, 500, cors); }
}

async function listAssignees(eid, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    const r = await env.DB.prepare(
      'SELECT tm.* FROM deal_assignees da JOIN team_members tm ON tm.id = da.member_id WHERE da.enquiry_id = ? ORDER BY tm.id'
    ).bind(eid).all();
    return json({ assignees: r.results || [] }, 200, cors);
  } catch (e) { console.error('listAssignees', e); return json({ error: 'Database error' }, 500, cors); }
}

async function setAssignees(eid, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const ids = Array.isArray(b.member_ids) ? b.member_ids : [];
  try {
    await env.DB.prepare('DELETE FROM deal_assignees WHERE enquiry_id = ?').bind(eid).run();
    for (const mid of ids) {
      await env.DB.prepare('INSERT OR IGNORE INTO deal_assignees (enquiry_id, member_id) VALUES (?, ?)').bind(eid, mid).run();
    }
    return json({ ok: true }, 200, cors);
  } catch (e) { console.error('setAssignees', e); return json({ error: 'Database error' }, 500, cors); }
}

/* ── Send email from a chosen incremento.co address ──────── */
const SEND_SIGS = {
  'robin@incremento.co':   { fromName: 'Robin Savile', name: 'Robin Savile', role: 'Founder, Incremento', tagline: 'Your complete digital solution' },
  'contact@incremento.co': { fromName: 'Incremento',   name: 'Incremento',    role: '',                    tagline: 'Your complete digital solution' },
  'contacto@incremento.co':{ fromName: 'Incremento',   name: 'Incremento',    role: '',                    tagline: 'A sua solução digital completa' },
  'help@incremento.co':    { fromName: 'Incremento Support', name: 'Incremento Support', role: '',          tagline: 'Here to help' },
};

function escEmail(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildSentEmailHtml(bodyText, sig) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#1a2733">
    <div style="white-space:pre-wrap">${escEmail(bodyText)}</div>
    <table cellpadding="0" cellspacing="0" border="0" style="margin-top:26px"><tr><td style="background:#0e1820;border-radius:12px;padding:18px 22px;">
      <div style="font-family:'Space Grotesk',Arial,sans-serif;font-size:18px;font-weight:700;color:#eef3f8">incremento<span style="color:#9EF54A">.</span></div>
      <div style="margin-top:10px;font-size:15px;color:#ffffff;font-weight:bold">${escEmail(sig.name)}</div>
      ${sig.role ? `<div style="font-size:12px;color:#9fb3c6;margin-top:1px">${escEmail(sig.role)}</div>` : ''}
      <div style="margin-top:9px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#5EE7D8">${escEmail(sig.tagline)}</div>
      <div style="margin-top:9px;font-size:12px"><a href="https://incremento.co" style="color:#9EF54A;text-decoration:none">incremento.co</a></div>
    </td></tr></table>
  </div>`;
}

async function sendEmail(request, env, cors) {
  if (!env.RESEND_API_KEY) return json({ error: 'Email not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const from = SEND_SIGS[(b.from || '').toLowerCase()] ? b.from.toLowerCase() : 'contact@incremento.co';
  const to = (b.to || '').trim();
  const subject = (b.subject || '').trim();
  const bodyText = (b.body || '').trim();
  if (!to)       return json({ error: 'Recipient required' }, 400, cors);
  if (!bodyText) return json({ error: 'Message body required' }, 400, cors);
  const sig = SEND_SIGS[from];
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${sig.fromName} <${from}>`,
        to: [to],
        reply_to: from,
        subject: subject || '(no subject)',
        html: buildSentEmailHtml(bodyText, sig),
        text: bodyText + '\n\n— ' + sig.name + '\nincremento.co',
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ error: 'Send failed', detail }, 502, cors);
    }
    await logMessage(env, {
      contact_email: to, enquiry_id: b.enquiry_id || null,
      direction: 'outbound', kind: 'email', source: 'admin',
      subject, body: bodyText,
    });
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('sendEmail error:', e);
    return json({ error: 'Send error' }, 500, cors);
  }
}

/* ── POST / → form submission ────────────────────────────── */
async function handleEnquiry(request, env, cors) {
  let data;
  try { data = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { name, email, company, phone, interests = [] } = data;
  const message = (data.message || '').trim();   // message is optional

  if (!name || !email) {
    return json({ error: 'Missing required fields' }, 400, cors);
  }

  const submitted = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/Lisbon',
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const submittedISO = new Date().toISOString();
  const interestList = interests.length ? interests.join(', ') : 'Not specified';

  // 1. Store in D1 as a PENDING triage item (graceful — if DB not set up, still send email).
  //    It is NOT a deal yet: Robin triages it (new deal / merge into existing / not a deal).
  //    A primary contact is created only when it's accepted as a deal.
  try {
    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO enquiries (name, email, company, phone, interests, message, stage, submitted_at, triage_state)
         VALUES (?, ?, ?, ?, ?, ?, 'new', ?, 'pending')`
      ).bind(name, email, company || null, phone || null, JSON.stringify(interests), message, submittedISO).run();
    }
  } catch (dbErr) {
    console.error('D1 insert error:', dbErr);
  }

  // 2. Send email via Resend
  const html = buildEmailHtml({ name, email, company, phone, interestList, message, submitted });
  const plain = `New enquiry from ${name} (${email})${company ? ` · ${company}` : ''}${phone ? ` · ${phone}` : ''}\n\nInterested in: ${interestList}\n\nMessage:\n${message || '(no message provided)'}\n\nSubmitted: ${submitted}`;

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

  // Only confirmed deals (pending/dismissed triage items never show in the pipeline)
  let query  = "SELECT * FROM enquiries WHERE (triage_state IS NULL OR triage_state = 'deal')";
  const args = [];
  if (stage) { query += ' AND stage = ?'; args.push(stage); }
  query += ' ORDER BY submitted_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  try {
    const result = await env.DB.prepare(query).bind(...args).all();
    const enquiries = result.results || [];

    // Overlay primary contact name so pipeline cards stay current when a contact is updated
    const ids = enquiries.map(e => e.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const cts = (await env.DB.prepare(
        `SELECT enquiry_id, name, is_primary FROM contacts WHERE enquiry_id IN (${ph})`
      ).bind(...ids).all()).results || [];
      const bestByEnq = {};
      cts.forEach(c => {
        const cur = bestByEnq[c.enquiry_id];
        if (!cur || (c.is_primary ? 1 : 0) > (cur.is_primary ? 1 : 0)) bestByEnq[c.enquiry_id] = c;
      });
      enquiries.forEach(e => {
        const c = bestByEnq[e.id];
        if (c && c.name) e.contact_name = c.name;
      });
    }

    return json({ enquiries }, 200, cors);
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

  const { stage, notes, value, project_title, company, company_url, interests, language } = body;
  const updatedAt = new Date().toISOString();

  const setClauses = [];
  const args = [];

  if (language !== undefined)      { setClauses.push('language = ?');      args.push(normLang(language)); }
  if (stage !== undefined)         { setClauses.push('stage = ?');         args.push(stage); }
  if (notes !== undefined)         { setClauses.push('notes = ?');         args.push(notes); }
  if (value !== undefined)         { setClauses.push('value = ?');         args.push(Number(value) || 0); }
  if (project_title !== undefined) { setClauses.push('project_title = ?'); args.push(project_title); }
  if (company !== undefined)       { setClauses.push('company = ?');       args.push(company); }
  if (company_url !== undefined)   { setClauses.push('company_url = ?');   args.push(company_url); }
  if (interests !== undefined)     { setClauses.push('interests = ?');     args.push(JSON.stringify(Array.isArray(interests) ? interests : [])); }
  setClauses.push('updated_at = ?'); args.push(updatedAt);

  if (setClauses.length === 1) {
    return json({ error: 'Nothing to update' }, 400, cors);
  }

  args.push(id);

  try {
    await env.DB.prepare(
      `UPDATE enquiries SET ${setClauses.join(', ')} WHERE id = ?`
    ).bind(...args).run();

    // Keep linked proposals in step with the deal stage (forward-only - never downgrade
    // a proposal that's already further along). Moving a deal to "Proposal Sent" marks
    // its draft proposals as sent; moving it to "Accepted" marks them accepted.
    if (stage !== undefined) {
      const now = new Date().toISOString();
      if (stage === 'proposal_sent') {
        await env.DB.prepare(
          `UPDATE proposals SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = ?
           WHERE enquiry_id = ? AND status = 'draft' AND (archived IS NULL OR archived = 0)`
        ).bind(now, now, id).run();
      } else if (stage === 'accepted') {
        await env.DB.prepare(
          `UPDATE proposals SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?), updated_at = ?
           WHERE enquiry_id = ? AND status IN ('draft','sent','viewed') AND (archived IS NULL OR archived = 0)`
        ).bind(now, now, id).run();
      }
    }

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
    const DEAL = "(triage_state IS NULL OR triage_state = 'deal')";
    const [totalRes, stageRes, revenueRes, triageRes] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) as count FROM enquiries WHERE ${DEAL}`).first(),
      env.DB.prepare(`SELECT stage, COUNT(*) as count FROM enquiries WHERE ${DEAL} GROUP BY stage`).all(),
      env.DB.prepare(`SELECT SUM(value) as total FROM enquiries WHERE ${DEAL} AND stage NOT IN ('cancelled','on_hold') AND value > 0`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM enquiries WHERE triage_state = 'pending'`).first(),
    ]);

    return json({
      total:             totalRes?.count || 0,
      new_count:         (stageRes.results || []).find(r => r.stage === 'new')?.count || 0,
      triage_count:      triageRes?.count || 0,
      stage_counts:      stageRes.results || [],
      potential_revenue: revenueRes?.total || 0,
    }, 200, cors);
  } catch (err) {
    console.error('D1 stats error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── Triage: pending inbound submissions ─────────────────────
   Each pending item gets a suggested match against existing deals,
   ranked email > company > domain (free-mail domains ignored).      */
const FREE_MAIL = new Set([
  'gmail.com','googlemail.com','hotmail.com','hotmail.co.uk','outlook.com','live.com',
  'yahoo.com','yahoo.co.uk','icloud.com','me.com','aol.com','proton.me','protonmail.com',
  'gmx.com','mail.com','zoho.com','yandex.com','sapo.pt','hotmail.es','outlook.es',
]);
const domainOf = e => (e && e.includes('@')) ? e.split('@')[1].toLowerCase().trim() : '';

async function listTriage(env, cors) {
  if (!env.DB) return json({ items: [] }, 200, cors);
  try {
    const pend = (await env.DB.prepare(
      "SELECT * FROM enquiries WHERE triage_state = 'pending' ORDER BY submitted_at DESC"
    ).all()).results || [];
    if (!pend.length) return json({ items: [] }, 200, cors);

    const deals = (await env.DB.prepare(
      "SELECT id, name, email, company FROM enquiries WHERE (triage_state IS NULL OR triage_state = 'deal') ORDER BY id DESC"
    ).all()).results || [];
    const contacts = (await env.DB.prepare(
      "SELECT enquiry_id, email FROM contacts WHERE email IS NOT NULL"
    ).all()).results || [];

    const dealById = {}; deals.forEach(d => { dealById[d.id] = d; });
    const labelOf = d => d ? (d.company || d.name || ('Deal #' + d.id)) : '';

    const items = pend.map(p => {
      const pe = (p.email || '').toLowerCase().trim();
      const pdom = domainOf(p.email);
      const pco = (p.company || '').trim().toLowerCase();
      let match = null;

      // 1. exact email — on a deal's own email, or any contact on a deal
      let d = pe && deals.find(x => (x.email || '').toLowerCase().trim() === pe);
      if (!d && pe) {
        const c = contacts.find(x => (x.email || '').toLowerCase().trim() === pe);
        if (c) d = dealById[c.enquiry_id];
      }
      if (d) match = { type: 'email', enquiry_id: d.id, label: labelOf(d) };

      // 2. same company name
      if (!match && pco) {
        d = deals.find(x => (x.company || '').trim().toLowerCase() === pco);
        if (d) match = { type: 'company', enquiry_id: d.id, label: labelOf(d) };
      }

      // 3. same (non-free) email domain
      if (!match && pdom && !FREE_MAIL.has(pdom)) {
        d = deals.find(x => domainOf(x.email) === pdom);
        if (!d) {
          const c = contacts.find(x => domainOf(x.email) === pdom);
          if (c) d = dealById[c.enquiry_id];
        }
        if (d) match = { type: 'domain', enquiry_id: d.id, label: labelOf(d) };
      }

      return { ...p, match };
    });
    return json({ items }, 200, cors);
  } catch (e) {
    console.error('listTriage error:', e);
    return json({ error: 'Database error', items: [] }, 500, cors);
  }
}

/* Accept a pending item as a brand-new deal */
async function triageAccept(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    const e = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ?').bind(id).first();
    if (!e) return json({ error: 'Not found' }, 404, cors);
    await env.DB.prepare("UPDATE enquiries SET triage_state = 'deal' WHERE id = ?").bind(id).run();
    const c = await env.DB.prepare('SELECT id FROM contacts WHERE enquiry_id = ? LIMIT 1').bind(id).first();
    if (!c) {
      await env.DB.prepare(
        "INSERT INTO contacts (enquiry_id, name, email, phone, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)"
      ).bind(id, e.name, e.email, e.phone || null, e.submitted_at || new Date().toISOString()).run();
    }
    return json({ ok: true, enquiry_id: id }, 200, cors);
  } catch (err) {
    console.error('triageAccept error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* Merge a pending item into an existing deal (adds the sender as a contact + logs the message) */
async function triageMerge(id, request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
  const target = parseInt(b.target_enquiry_id);
  if (!target) return json({ error: 'target_enquiry_id required' }, 400, cors);
  try {
    const e = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ?').bind(id).first();
    if (!e) return json({ error: 'Not found' }, 404, cors);
    if (e.email) {
      const exists = await env.DB.prepare(
        'SELECT id FROM contacts WHERE enquiry_id = ? AND lower(email) = ?'
      ).bind(target, e.email.toLowerCase()).first();
      if (!exists) {
        await env.DB.prepare(
          "INSERT INTO contacts (enquiry_id, name, email, is_primary, created_at) VALUES (?, ?, ?, 0, ?)"
        ).bind(target, e.name, e.email, new Date().toISOString()).run();
      }
    }
    await logMessage(env, {
      contact_email: e.email, enquiry_id: target,
      direction: 'inbound', kind: 'enquiry', source: 'form',
      subject: 'New website enquiry', body: e.message,
    });
    await env.DB.prepare("UPDATE enquiries SET triage_state = 'dismissed' WHERE id = ?").bind(id).run();
    return json({ ok: true, enquiry_id: target }, 200, cors);
  } catch (err) {
    console.error('triageMerge error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* Dismiss a pending item (sales email / spam / not a deal) */
async function triageDismiss(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    await env.DB.prepare("UPDATE enquiries SET triage_state = 'dismissed' WHERE id = ?").bind(id).run();
    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('triageDismiss error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* ── Email HTML builder ──────────────────────────────────── */
function buildEmailHtml({ name, email, company, phone, interestList, message, submitted }) {
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
                  ${(company || phone) ? `<tr>
                    ${company ? `<td width="50%" style="padding-bottom:20px"><p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Company</p><p style="margin:0;font-size:16px;color:#e0e8f0">${escHtml(company)}</p></td>` : '<td width="50%"></td>'}
                    ${phone ? `<td width="50%" style="padding-bottom:20px"><p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Phone</p><p style="margin:0;font-size:16px"><a href="tel:${escHtml(phone)}" style="color:#9EF54A;text-decoration:none">${escHtml(phone)}</a></p></td>` : '<td width="50%"></td>'}
                  </tr>` : ''}
                  <tr><td colspan="2" style="padding-bottom:20px">
                    <p style="margin:0 0 3px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Interested in</p>
                    <p style="margin:0;font-size:16px;color:#e0e8f0">${escHtml(interestList)}</p>
                  </td></tr>
                </table>
              </td></tr>
              <tr><td style="padding-top:20px">
                <p style="margin:0 0 8px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#5EE7D8">Message</p>
                <div style="background:#152332;border-radius:8px;padding:18px;border-left:3px solid #9EF54A">
                  <p style="margin:0;font-size:15px;color:#b0bec8;line-height:1.7;white-space:pre-wrap">${message ? escHtml(message) : '<span style="color:#5f7180;font-style:italic">No message provided</span>'}</p>
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
    intro:       { type: 'string', description: 'Warm 2-3 sentence opening for the accompanying email. IMPORTANT: a proposal is only ever sent AFTER at least one meeting/call with the client, so open by referencing that conversation (e.g. "It was great to talk through your project", "Following our conversation", "Conforme conversámos") - NEVER thank them for getting in touch or for their enquiry, as if it were a first contact. Reference the client goals discussed. Write it in the client language. Do NOT include any greeting or salutation (no "Hi NAME", no "Olá NAME") and do NOT name the recipient - the email adds the greeting line separately.' },
    executive_summary: { type: 'string', description: 'Executive summary, 3-5 sentences: the hook (the client situation and challenge) PLUS the value proposition (how this combined work elevates their brand and solves the problem). Confident, specific, no buzzwords.' },
    challenges:  { type: 'string', description: '2-4 sentences naming the current bottlenecks this project addresses (e.g. outdated UX, low conversion, weak online visibility), tailored to this client.' },
    goals:       { type: 'array', items: { type: 'string' }, description: '3-5 specific, measurable SMART goals (e.g. "Increase organic traffic by 40% within 6 months", "Lift lead generation by 20%").' },
    kpis:        { type: 'array', items: { type: 'string' }, description: '3-5 KPIs by which success will be measured (e.g. "Cost per acquisition (CPA)", "Organic traffic growth", "Conversion rate").' },
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
  required: ['title', 'intro', 'executive_summary', 'challenges', 'goals', 'kpis', 'scope', 'deliverables', 'timeline', 'pricing', 'terms'],
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

  const lang = normLang(enquiry.language);
  const langName = lang === 'pt' ? 'European Portuguese (pt-PT)' : 'English';

  // Components hand-picked by Robin in the library picker (optional) — these are the backbone.
  const components = Array.isArray(body.components) ? body.components.filter(c => c && c.title) : [];
  const compBlock = components.length ? `

The team has hand-picked these service components to include. Use them as the BACKBONE of the proposal:
- Turn each component into a Scope workstream: keep its name as the title and expand the description so it speaks directly to THIS client and project (tailor it, do not just copy the library wording verbatim).
- Create a matching Pricing line item for each. Where a component already has a price, use it; where it is blank, estimate a sensible figure for a senior Lisbon studio.
- Group the work into a realistic Timeline, and write a warm, specific intro plus clear Terms.
Selected components:
${components.map(c => `- ${c.title}${(c.price !== '' && c.price != null) ? ` (€${c.price})` : ''}${c.body ? ` - ${c.body}` : ''}`).join('\n')}
` : '';

  const valueLine = enquiry.value > 0
    ? `Robin's estimated project value: €${enquiry.value}${components.length ? ' - make the pricing line items sum to roughly this.' : ' - anchor total pricing near this.'}`
    : (components.length
        ? 'No value estimate yet - price each component realistically for a senior Lisbon studio.'
        : 'No value estimate yet - price realistically for a senior Lisbon studio (websites 2,500-8,000 EUR, e-commerce 5,000-15,000 EUR, AI/custom software 8,000-30,000 EUR).');

  const direction = (body.direction || '').trim();
  const directionBlock = direction ? `

Robin's direction for this draft (FOLLOW THIS CLOSELY - it reflects what was discussed and how he wants the proposal pitched):
"""
${direction}
"""` : '';

  const prompt = `Draft a project proposal for this enquiry received via incremento.co:

Client name: ${enquiry.name}
Company: ${enquiry.company || 'not given'}
Interested in: ${interests.join(', ') || 'not specified'}
Their message:
"""
${enquiry.message}
"""
${enquiry.notes ? `Internal notes from Robin:\n"""\n${enquiry.notes}\n"""` : ''}
${directionBlock}
${compBlock}
${valueLine}`;

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
      system: `You write client proposals for Incremento, a Lisbon digital studio in two parts: Incremento Studio (web design & digital marketing) and Incremento Labs (custom software & AI consultancy). Voice: senior, warm, confident, no fluff or buzzwords. Write EVERYTHING (every field, including the title) in ${langName} - this is the client's chosen communication language; do not mix languages. Produce a COMPREHENSIVE structured proposal that fills every field: a punchy executive summary (the hook + the value proposition), the client's current challenges, 3-5 measurable SMART goals, a clear scope (cover both the website build AND any digital marketing where relevant), concrete deliverables, a phased timeline, an itemised investment, and the KPIs you will measure success by. Be specific to this client, not generic. When the team has selected specific components, build the scope and pricing around them; otherwise scope what the enquiry asks for. Prices in EUR. IMPORTANT STYLE RULE: never use the em dash (—); always use a single hyphen (-).`,
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
    language: lang,
  }, 200, cors);
}

/* ── Proposal CRUD ───────────────────────────────────────── */
function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function listProposals(env, url, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const archived = url && url.searchParams.get('archived') === '1';
  const where = archived ? 'archived = 1' : '(archived IS NULL OR archived = 0)';
  try {
    const result = await env.DB.prepare(`SELECT * FROM proposals WHERE ${where} ORDER BY created_at DESC LIMIT 200`).all();
    const props = result.results || [];

    // Overlay each proposal's client with its linked enquiry's current main contact
    const ids = [...new Set(props.map(p => p.enquiry_id).filter(Boolean))];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const enqs = (await env.DB.prepare(`SELECT id, name, email, company FROM enquiries WHERE id IN (${ph})`).bind(...ids).all()).results || [];
      const cts  = (await env.DB.prepare(`SELECT id, enquiry_id, name, email, is_primary FROM contacts WHERE enquiry_id IN (${ph})`).bind(...ids).all()).results || [];
      const enqById = {}; enqs.forEach(e => { enqById[e.id] = e; });
      const bestByEnq = {};   // primary first, then lowest id
      cts.forEach(c => {
        const cur = bestByEnq[c.enquiry_id];
        if (!cur || (c.is_primary?1:0) > (cur.is_primary?1:0) ||
            ((c.is_primary?1:0) === (cur.is_primary?1:0) && c.id < cur.id)) bestByEnq[c.enquiry_id] = c;
      });
      props.forEach(p => {
        if (!p.enquiry_id) return;
        const e = enqById[p.enquiry_id], c = bestByEnq[p.enquiry_id];
        const name = (c && c.name) || (e && e.name);
        const email = (c && c.email) || (e && e.email);
        if (name)  p.client_name = name;
        if (email) p.client_email = email;
        if (e && e.company) p.client_company = e.company;
      });
    }
    return json({ proposals: props }, 200, cors);
  } catch (err) {
    console.error('D1 proposals list error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* The current "main contact" for an enquiry: its primary contact record,
   falling back to the next contact, then the enquiry's own details. Company
   always comes from the deal/enquiry. */
async function mainContactFor(env, enquiryId) {
  if (!enquiryId) return null;
  const enq = await env.DB.prepare('SELECT name, email, company FROM enquiries WHERE id = ?').bind(enquiryId).first();
  const c = await env.DB.prepare(
    'SELECT name, email FROM contacts WHERE enquiry_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
  ).bind(enquiryId).first();
  return {
    name:    (c && c.name)  || (enq && enq.name)  || '',
    email:   (c && c.email) || (enq && enq.email) || '',
    company: (enq && enq.company) || '',
  };
}

/* Overlay the linked enquiry's main-contact details onto a proposal row, so the
   client name/email/company always reflect (and update with) that contact. */
async function withLiveClient(env, row) {
  if (!row || !row.enquiry_id) return row;
  const mc = await mainContactFor(env, row.enquiry_id);
  if (mc) {
    if (mc.name)    row.client_name    = mc.name;
    if (mc.email)   row.client_email   = mc.email;
    if (mc.company) row.client_company = mc.company;
  }
  return row;
}

async function getProposal(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const row = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404, cors);
  return json(await withLiveClient(env, row), 200, cors);
}

async function createProposal(request, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { title, client_name, client_email, client_company, content, total_value, valid_until, enquiry_id, language } = body;
  if (!title || !client_name) return json({ error: 'title and client_name are required' }, 400, cors);

  const token = makeToken();
  const now = new Date().toISOString();

  try {
    const res = await env.DB.prepare(
      `INSERT INTO proposals (enquiry_id, token, title, client_name, client_email, client_company, status, content, total_value, valid_until, language, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
    ).bind(
      enquiry_id || null, token, title, client_name, client_email || null, client_company || null,
      JSON.stringify(content || {}), Number(total_value) || 0, valid_until || null, normLang(language), now
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

  const fields = ['title', 'client_name', 'client_email', 'client_company', 'status', 'total_value', 'valid_until', 'archived', 'language'];
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

/* DELETE /api/enquiries/:id — remove a deal and everything attached to it
   (contacts, team assignments, comms, proposals). For testing / spam cleanup. */
async function deleteEnquiry(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM contacts WHERE enquiry_id = ?').bind(id),
      env.DB.prepare('DELETE FROM deal_assignees WHERE enquiry_id = ?').bind(id),
      env.DB.prepare('DELETE FROM messages WHERE enquiry_id = ?').bind(id),
      env.DB.prepare('DELETE FROM proposals WHERE enquiry_id = ?').bind(id),
      env.DB.prepare('DELETE FROM enquiries WHERE id = ?').bind(id),
    ]);
    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('deleteEnquiry error:', err);
    return json({ error: 'Database error' }, 500, cors);
  }
}

/* Build the exact email payload (subject/html/text) for a proposal.
   Shared by the live send and the send-preview so what Robin authorises
   is byte-for-byte what the client receives. */
async function buildProposalEmailPayload(p, env) {
  const lang = normLang(p.language);
  const tpl  = await getEmailTemplate(env, lang);
  const link = `${env.PROPOSALS_URL || 'https://enquiries.incremento.co'}/p/${p.token}`;
  const fp   = (str) => fillTokensPlain(str, p);
  return {
    from:     `Robin at Incremento <${env.FROM_EMAIL}>`,
    to:       p.client_email,
    reply_to: env.TO_EMAIL,
    subject:  fp(tpl.subject || EMAIL_TEMPLATE_DEFAULTS[lang].subject),
    html:     buildProposalEmailHtml(p, link, tpl),
    text:     `${fp(tpl.greeting)}\n\n${fp(tpl.intro)}\n\n${link}\n\n${tpl.signature}`,
    link,
  };
}

/* ── GET /api/proposals/:id/send-preview → render, don't send ── */
async function previewProposalEmail(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  if (!p) return json({ error: 'Not found' }, 404, cors);
  await withLiveClient(env, p);   // always address the deal's current main contact
  if (!p.client_email) return json({ error: 'Proposal has no client email' }, 400, cors);
  const e = await buildProposalEmailPayload(p, env);
  const intro = await effectiveIntroText(p, env);
  return json({ to: e.to, subject: e.subject, html: e.html, text: e.text, link: e.link, intro }, 200, cors);
}

/* ── POST /api/proposals/:id/send → email link to client ── */
async function sendProposal(id, env, cors) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503, cors);
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  if (!p) return json({ error: 'Not found' }, 404, cors);
  await withLiveClient(env, p);   // always send to / address the deal's current main contact
  if (!p.client_email) return json({ error: 'Proposal has no client email' }, 400, cors);

  const e = await buildProposalEmailPayload(p, env);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:     e.from,
      to:       [e.to],
      reply_to: e.reply_to,
      subject:  e.subject,
      html:     e.html,
      text:     e.text,
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
    subject: e.subject,
    body: `Sent the proposal "${p.title}" (${'€' + Number(p.total_value).toLocaleString()}). Link: ${e.link}`,
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
/* Static chrome for the public proposal page, per language. Heading pairs are
   {a: plain, b: accent} so we can render "Scope of <accent>work</accent>". */
const PROP_LABELS = {
  en: {
    htmlLang: 'en', dateLocale: 'en-GB',
    eyebrow: 'Project Proposal',
    preparedFor: 'Prepared for', preparedBy: 'Prepared by', preparedByVal: 'Incremento · Lisbon',
    date: 'Date', validUntil: 'valid until',
    exec: { a: 'Executive ', b: 'summary' },
    objectives: { a: 'Objectives &amp; ', b: 'challenges' }, aimFor: "What we'll aim for",
    scope: { a: 'Scope of ', b: 'work' },
    receive: { a: "What you'll ", b: 'receive' },
    timeline: { a: '', b: 'Timeline' },
    investment: 'Investment', total: 'Total', measure: "How we'll measure success",
    why: { a: 'Why ', b: 'Incremento' },
    years: 'years', projectsShipped: 'projects shipped', specialists: 'senior specialists',
    whyText: 'Web, product and growth under one roof, plus Incremento Labs for applied AI. You work directly with senior people who ship - no juniors, no handoffs, no fluff. We start with your goals and your customers, not a template, so what we build actually moves your numbers.',
    ledBy: 'Led by Robin Savile',
    ledByText: 'Incremento is led by Robin Savile, who brings over 20 years of digital, product and growth-marketing experience across B2B and B2C. He has led search marketing for brands including the Four Seasons Hotels across the EMEA region, Cancer Research UK and MyVoucherCodes. A genuinely safe pair of hands who pairs senior strategy with hands-on delivery, so you always deal directly with the person doing the thinking.',
    terms: 'Terms',
    acceptedBadge: 'Proposal accepted - thank you!', signedBy: 'Signed by', on: 'on',
    kickOff: "We'll be in touch shortly to kick things off.",
    printPdf: 'Print / Save as PDF',
    declinedMsg: 'This proposal has been declined.',
    changedMind: "Changed your mind? Just reply to the email this came with and we'll sort it out.",
    expiredMsg: 'This proposal has expired', expiredValid: 'it was valid until ',
    stillInterested: "Still interested? Reply to the email this came with and we'll send you a fresh one.",
    previewAcceptNote: 'The client will see a <strong style="color:var(--lime)">signature + Accept</strong> form here (and a Decline option).',
    signToAccept: 'Sign to accept', typeName: 'Type your full name',
    agreeTerms: 'I agree to the scope, timeline and terms set out above.',
    acceptBtn: 'Accept this proposal', declineBtn: 'Decline this proposal',
    questions: 'Questions? Just reply to the email this came with.',
    previewBanner: 'PREVIEW - this is how your client will see it', notSent: ' (not sent yet)',
    nameErr: 'Please type your full name to sign.', agreeErr: 'Please tick the box to agree to the terms.',
    accepting: 'Accepting…', tryAgain: 'Try again', somethingWrong: 'Something went wrong.', networkError: 'Network error - please try again.',
    declining: 'Declining…', declineConfirm: 'Decline this proposal?', declineReason: 'Optional - let us know why (helps us improve). Leave blank to skip.',
  },
  pt: {
    htmlLang: 'pt', dateLocale: 'pt-PT',
    eyebrow: 'Proposta de Projeto',
    preparedFor: 'Preparada para', preparedBy: 'Preparada por', preparedByVal: 'Incremento · Lisboa',
    date: 'Data', validUntil: 'válida até',
    exec: { a: 'Resumo ', b: 'executivo' },
    objectives: { a: 'Objetivos e ', b: 'desafios' }, aimFor: 'O que vamos procurar alcançar',
    scope: { a: 'Âmbito do ', b: 'trabalho' },
    receive: { a: 'O que vai ', b: 'receber' },
    timeline: { a: '', b: 'Calendário' },
    investment: 'Investimento', total: 'Total', measure: 'Como vamos medir o sucesso',
    why: { a: 'Porquê a ', b: 'Incremento' },
    years: 'anos', projectsShipped: 'projetos entregues', specialists: 'especialistas seniores',
    whyText: 'Web, produto e crescimento sob o mesmo teto, mais o Incremento Labs para IA aplicada. Trabalha diretamente com profissionais seniores que entregam - sem juniores, sem intermediários, sem enrolação. Começamos pelos seus objetivos e pelos seus clientes, não por um modelo, para que aquilo que construímos faça realmente mexer os seus números.',
    ledBy: 'Liderada por Robin Savile',
    ledByText: 'A Incremento é liderada por Robin Savile, que traz mais de 20 anos de experiência em digital, produto e marketing de crescimento em B2B e B2C. Liderou marketing de pesquisa para marcas como os hotéis Four Seasons na região EMEA, a Cancer Research UK e a MyVoucherCodes. Um par de mãos verdadeiramente seguro, que combina estratégia sénior com execução prática, para que lide sempre diretamente com quem está a pensar o trabalho.',
    terms: 'Termos',
    acceptedBadge: 'Proposta aceite - obrigado!', signedBy: 'Assinada por', on: 'em',
    kickOff: 'Entraremos em contacto em breve para começarmos.',
    printPdf: 'Imprimir / Guardar como PDF',
    declinedMsg: 'Esta proposta foi recusada.',
    changedMind: 'Mudou de ideias? Basta responder ao email que acompanha esta proposta e tratamos disso.',
    expiredMsg: 'Esta proposta expirou', expiredValid: 'era válida até ',
    stillInterested: 'Ainda interessado? Responda ao email que acompanha esta proposta e enviamos-lhe uma nova.',
    previewAcceptNote: 'O cliente verá aqui um formulário de <strong style="color:var(--lime)">assinatura + Aceitar</strong> (e uma opção para Recusar).',
    signToAccept: 'Assine para aceitar', typeName: 'Escreva o seu nome completo',
    agreeTerms: 'Concordo com o âmbito, o calendário e os termos acima.',
    acceptBtn: 'Aceitar esta proposta', declineBtn: 'Recusar esta proposta',
    questions: 'Questões? Basta responder ao email que acompanha esta proposta.',
    previewBanner: 'PRÉ-VISUALIZAÇÃO - é assim que o seu cliente a verá', notSent: ' (ainda não enviada)',
    nameErr: 'Escreva o seu nome completo para assinar.', agreeErr: 'Assinale a caixa para concordar com os termos.',
    accepting: 'A aceitar…', tryAgain: 'Tentar novamente', somethingWrong: 'Algo correu mal.', networkError: 'Erro de rede - tente novamente.',
    declining: 'A recusar…', declineConfirm: 'Recusar esta proposta?', declineReason: 'Opcional - diga-nos porquê (ajuda-nos a melhorar). Deixe em branco para ignorar.',
  },
};

async function renderProposalPage(token, env, url) {
  if (!env.DB) return new Response('Service unavailable', { status: 503 });
  const p = await env.DB.prepare('SELECT * FROM proposals WHERE token = ?').bind(token).first();
  const isPdf   = url && url.searchParams.get('pdf') === '1';
  const preview = (url && url.searchParams.get('preview') === '1') || isPdf;  // pdf is an admin action too
  if (!p || (p.status === 'draft' && !preview)) return new Response('Proposal not found', { status: 404 });

  // Client name/company always reflect the linked enquiry's current main contact
  await withLiveClient(env, p);

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

  const L = PROP_LABELS[normLang(p.language)];
  const why = await getWhyContent(env, p.language);
  const eur = n => '€' + Number(n || 0).toLocaleString('en-IE');
  const accepted = p.status === 'accepted';
  const declined = p.status === 'declined';
  const expired  = isExpired(p) && !preview;
  const fmtDate  = d => d ? new Date(d).toLocaleDateString(L.dateLocale, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const previewBanner = preview
    ? `<div class="no-print" style="position:sticky;top:0;z-index:10;background:#f59e0b;color:#0a1219;text-align:center;font-weight:700;font-size:0.82rem;padding:9px 16px;font-family:'Space Grotesk',sans-serif;letter-spacing:0.04em">${L.previewBanner}${p.status === 'draft' ? L.notSent : ''}</div>`
    : '';

  const scopeHtml = (c.scope || []).map((s, i) => `
    <div class="scope-item">
      <div class="scope-num">${String(i + 1).padStart(2, '0')}</div>
      <div><h3>${escHtml(s.title)}</h3><p>${escHtml(s.description)}</p></div>
    </div>`).join('');

  const delivHtml = (c.deliverables || []).map(d => `<li>${escHtml(d)}</li>`).join('');
  const goalsHtml = (c.goals || []).map(g => `<li>${escHtml(g)}</li>`).join('');
  const kpisHtml  = (c.kpis  || []).map(k => `<li>${escHtml(k)}</li>`).join('');

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
<html lang="${L.htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escHtml(p.title)} - Incremento</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b141c;--surface:#101d28;--surface2:#16242f;--line:rgba(255,255,255,0.11);--line-soft:rgba(255,255,255,0.06);--text:#eaf1f7;--dim:#94a7b5;--lime:#9EF54A;--cyan:#5EE7D8}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:var(--bg)}
body{color:var(--text);font-family:'Inter',sans-serif;line-height:1.72;font-size:15.5px;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:'Space Grotesk',sans-serif;letter-spacing:-0.02em;color:var(--text)}
.wrap{max-width:840px;margin:0 auto;padding:0 36px;counter-reset:sec}
.eyebrow{font-size:0.7rem;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:var(--cyan)}
.accent{background:linear-gradient(120deg,var(--lime),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
.brand{display:flex;align-items:center;gap:11px}
.brand span{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:1.15rem;letter-spacing:-0.02em}
.brand .dot{color:var(--lime)}

/* ── COVER PAGE (full A4) ── */
.cover-page{min-height:calc(100vh - 0px);display:flex;flex-direction:column;padding:60px 0 52px;page-break-after:always}
.cover-mid{margin:auto 0}
.cover-rule{width:56px;height:3px;border-radius:3px;background:linear-gradient(120deg,var(--lime),var(--cyan));margin:0 0 26px}
.cover-page .eyebrow{margin-bottom:0}
.cover-page h1{font-size:clamp(2.4rem,6vw,3.6rem);line-height:1.07;margin-top:20px;max-width:14ch}
.cover-meta{border-top:1px solid var(--line);padding-top:28px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.cm-lbl{display:block;font-size:0.65rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--dim);margin-bottom:7px}
.cm-val{font-size:0.92rem;color:var(--text);line-height:1.5}

/* ── SECTIONS ── */
section{counter-increment:sec;padding-top:46px;margin-top:46px;border-top:1px solid var(--line-soft)}
section:first-of-type{border-top:none;margin-top:0}
h2{font-size:1.55rem;display:flex;align-items:baseline;gap:16px;margin-bottom:24px}
h2:before{content:counter(sec,decimal-leading-zero);font-size:0.85rem;font-weight:700;color:var(--lime);-webkit-text-fill-color:var(--lime);letter-spacing:0.05em;flex:0 0 auto}
.lead{font-size:1.08rem;color:var(--text);line-height:1.8;max-width:64ch}
.subhead{font-family:'Space Grotesk',sans-serif;font-size:1.02rem;font-weight:600;margin:30px 0 14px;color:var(--text);letter-spacing:-0.01em}

/* Scope */
.scope-item{display:flex;gap:20px;padding:20px 0;border-bottom:1px solid var(--line-soft)}
.scope-item:last-child{border-bottom:none}
.scope-num{font-family:'Space Grotesk',sans-serif;font-weight:700;color:var(--lime);font-size:0.92rem;min-width:28px;padding-top:2px}
.scope-item h3{font-size:1.08rem;margin-bottom:5px}
.scope-item p{color:var(--dim);font-size:0.95rem;max-width:62ch}

/* Tick lists (deliverables / goals / kpis) */
ul.deliv{list-style:none;display:grid;gap:0}
ul.deliv li{padding:12px 0 12px 30px;position:relative;border-bottom:1px solid var(--line-soft);font-size:0.97rem;color:var(--text)}
ul.deliv li:last-child{border-bottom:none}
ul.deliv li:before{content:"";position:absolute;left:2px;top:18px;width:13px;height:13px;background:var(--lime);clip-path:polygon(14% 44%,0 60%,40% 100%,100% 16%,84% 4%,38% 72%)}

/* Timeline */
.time-row{display:grid;grid-template-columns:155px 105px 1fr;gap:18px;padding:17px 0;border-bottom:1px solid var(--line-soft);font-size:0.95rem}
.time-row:last-child{border-bottom:none}
.time-phase{font-weight:600;font-family:'Space Grotesk',sans-serif;color:var(--text)}
.time-dur{color:var(--lime);font-size:0.82rem;font-weight:500}
.time-desc{color:var(--dim)}
@media(max-width:560px){.time-row{grid-template-columns:1fr;gap:3px}}

/* Pricing — framed */
table.pricing{width:100%;border-collapse:separate;border-spacing:0;margin-top:4px;border:1px solid var(--line);border-radius:12px;overflow:hidden}
table.pricing td{padding:16px 22px;border-bottom:1px solid var(--line-soft);vertical-align:top;font-size:0.96rem;color:var(--text)}
table.pricing tr:last-child td{border-bottom:none}
.price-desc{color:var(--dim);font-size:0.86rem;margin-top:3px;display:block}
.price-amt{text-align:right;font-family:'Space Grotesk',sans-serif;font-weight:600;white-space:nowrap;padding-left:20px}
.total-row{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:20px 26px;background:var(--surface2);border-radius:12px;border:1px solid var(--line)}
.total-row .lbl{font-size:0.74rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--dim)}
.total-row .amt{font-family:'Space Grotesk',sans-serif;font-size:1.7rem;font-weight:700;color:var(--lime);-webkit-text-fill-color:var(--lime)}

/* Why */
.why-grid{display:flex;gap:50px;margin:8px 0 24px;flex-wrap:wrap}
.why-num{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:2.2rem;color:var(--lime);line-height:1}
.why-lbl{color:var(--dim);font-size:0.74rem;letter-spacing:0.1em;text-transform:uppercase;margin-top:6px}
.why-text{color:var(--dim);font-size:1rem;max-width:64ch;line-height:1.78;margin-bottom:4px}

/* Terms */
.terms{color:var(--dim);font-size:0.92rem;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:22px 26px;line-height:1.75}

/* CTA + footer */
.cta{margin-top:54px;text-align:center;padding:46px 28px;background:var(--surface);border:1px solid var(--line);border-radius:16px}
.btn-accept{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,var(--lime),var(--cyan));color:#0a1219;font-weight:700;font-size:1rem;padding:15px 36px;border-radius:10px;border:none;cursor:pointer;font-family:'Space Grotesk',sans-serif;letter-spacing:-0.01em}
.btn-accept:disabled{opacity:0.6;cursor:default}
.btn-pdf{display:inline-flex;align-items:center;gap:7px;margin-left:14px;background:none;border:1px solid var(--line);color:var(--dim);padding:14px 22px;border-radius:10px;cursor:pointer;font-size:0.88rem;font-family:'Inter',sans-serif}
.accepted-badge{display:inline-flex;align-items:center;gap:8px;color:var(--lime);font-weight:600;font-family:'Space Grotesk',sans-serif;font-size:1.05rem}
.cta p{color:var(--dim);font-size:0.85rem;margin-top:14px}
footer{margin-top:60px;padding-top:24px;border-top:1px solid var(--line-soft);text-align:center;color:var(--dim);font-size:0.8rem}
footer a{color:var(--cyan);text-decoration:none}

/* Page-break control */
.page-break{height:0;break-before:page;page-break-before:always}
section,.scope-item,.time-row,.total-row,.why-grid,tr{break-inside:avoid;page-break-inside:avoid}

/* ── PRINT: crisp vector A4, dark preserved ── */
@media print{
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  html,body{background:var(--bg)!important}
  .no-print,.cta,.btn-accept,.btn-pdf{display:none!important}
  /* A safe margin on EVERY page (well clear of any printer's unprintable edge),
     plus a little inner breathing room so text never sits at the content edge. */
  @page{size:A4;margin:16mm}
  .wrap{max-width:none;padding:6mm 7mm}
  .cover-page{min-height:232mm;height:auto;padding:0;margin-bottom:0}
  h1,.cover-page h1{font-size:2.7rem}
  h2{font-size:1.4rem}
  .accent{-webkit-text-fill-color:var(--lime)!important;color:var(--lime)!important;background:none!important}
}
</style>
</head>
<body>
${previewBanner}
<div class="wrap">
  <!-- ── COVER PAGE ─────────────────────────────────────────── -->
  <div class="cover-page">
    <div class="brand">
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none"><defs><linearGradient id="g" x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#9EF54A"/><stop offset="100%" stop-color="#5EE7D8"/></linearGradient></defs><rect x="4" y="20" width="5" height="8" rx="2.5" fill="url(#g)" opacity="0.55"/><rect x="12" y="14" width="5" height="14" rx="2.5" fill="url(#g)" opacity="0.78"/><rect x="20" y="10" width="5" height="18" rx="2.5" fill="url(#g)"/><circle cx="22.5" cy="5.5" r="2.25" fill="url(#g)"/></svg>
      <span>incremento<span class="dot">.</span></span>
    </div>
    <div class="cover-mid">
      <div class="cover-rule"></div>
      <p class="eyebrow">${L.eyebrow}</p>
      <h1>${escHtml(p.title)}</h1>
    </div>
    <div class="cover-meta">
      <div><span class="cm-lbl">${L.preparedFor}</span><span class="cm-val">${escHtml(p.client_name)}${p.client_company ? ' · ' + escHtml(p.client_company) : ''}</span></div>
      <div><span class="cm-lbl">${L.preparedBy}</span><span class="cm-val">${L.preparedByVal}</span></div>
      <div><span class="cm-lbl">${L.date}</span><span class="cm-val">${fmtDate(p.created_at)}${p.valid_until ? ' · ' + L.validUntil + ' ' + fmtDate(p.valid_until) : ''}</span></div>
    </div>
  </div>
  <div class="page-break"></div>

  ${c.executive_summary ? `<section><h2>${L.exec.a}<span class="accent">${L.exec.b}</span></h2><p class="lead">${escHtml(c.executive_summary)}</p></section>` : ''}

  ${(c.challenges || goalsHtml) ? `<section><h2>${L.objectives.a}<span class="accent">${L.objectives.b}</span></h2>
    ${c.challenges ? `<p class="lead">${escHtml(c.challenges)}</p>` : ''}
    ${goalsHtml ? `<h3 class="subhead">${L.aimFor}</h3><ul class="deliv">${goalsHtml}</ul>` : ''}</section>` : ''}

  ${scopeHtml ? `<section><h2>${L.scope.a}<span class="accent">${L.scope.b}</span></h2>${scopeHtml}</section>` : ''}
  ${delivHtml ? `<section><h2>${L.receive.a}<span class="accent">${L.receive.b}</span></h2><ul class="deliv">${delivHtml}</ul></section>` : ''}
  ${timeHtml ? `<section><h2>${L.timeline.a}<span class="accent">${L.timeline.b}</span></h2>${timeHtml}</section>` : ''}

  ${priceHtml ? '<div class="page-break"></div>' : ''}
  ${priceHtml ? `<section><h2>${L.investment}</h2><table class="pricing">${priceHtml}</table>
    <div class="total-row"><span class="lbl">${L.total}</span><span class="amt">${eur(p.total_value)}</span></div>
    ${kpisHtml ? `<h3 class="subhead">${L.measure}</h3><ul class="deliv">${kpisHtml}</ul>` : ''}</section>` : ''}

  <section class="why">
    <h2>${L.why.a}<span class="accent">${L.why.b}</span></h2>
    <div class="why-grid">
      <div><div class="why-num">6</div><div class="why-lbl">${L.years}</div></div>
      <div><div class="why-num">20+</div><div class="why-lbl">${L.projectsShipped}</div></div>
      <div><div class="why-num">4</div><div class="why-lbl">${L.specialists}</div></div>
    </div>
    <p class="why-text">${nl2br(why.why_text)}</p>
    <h3 class="subhead">${escHtml(why.why_ledby_heading)}</h3>
    <p class="why-text">${nl2br(why.why_ledby_text)}</p>
  </section>

  ${c.terms ? `<section><h2>${L.terms}</h2><div class="terms">${escHtml(c.terms)}</div></section>` : ''}

  <div class="cta">
    ${accepted
      ? `<span class="accepted-badge"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>${L.acceptedBadge}</span>
         ${p.signed_name ? `<p>${L.signedBy} <strong style="color:var(--text)">${escHtml(p.signed_name)}</strong>${p.accepted_at ? ' ' + L.on + ' ' + fmtDate(p.accepted_at) : ''}.</p>` : ''}
         <p>${L.kickOff}</p>
         <button class="btn-pdf" style="margin-left:0" onclick="downloadPdf(this)">${L.printPdf}</button>`
      : declined
      ? `<span style="color:var(--dim);font-size:1rem;font-weight:600">${L.declinedMsg}</span>
         <p>${L.changedMind}</p>`
      : expired
      ? `<span style="color:#f59e0b;font-weight:700;font-size:1rem">${L.expiredMsg}${p.valid_until ? ' (' + L.expiredValid + fmtDate(p.valid_until) + ')' : ''}.</span>
         <p>${L.stillInterested}</p>
         <button class="btn-pdf" style="margin-left:0" onclick="downloadPdf(this)">${L.printPdf}</button>`
      : preview
      ? `<span style="color:var(--dim);font-size:0.9rem;display:block;margin-bottom:18px">${L.previewAcceptNote}</span>
         <button class="btn-pdf" style="margin-left:0" onclick="downloadPdf(this)">${L.printPdf}</button>`
      : `<div style="max-width:440px;margin:0 auto">
           <label style="display:block;font-size:0.8rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--cyan);margin-bottom:10px">${L.signToAccept}</label>
           <input id="sig-name" type="text" autocomplete="name" placeholder="${L.typeName}" style="width:100%;padding:13px 16px;border-radius:9px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:1rem;margin-bottom:14px">
           <label style="display:flex;gap:10px;align-items:flex-start;font-size:0.86rem;color:var(--dim);text-align:left;margin-bottom:6px;cursor:pointer"><input type="checkbox" id="agree" style="margin-top:4px;flex:0 0 auto"> <span>${L.agreeTerms}</span></label>
           <div id="accept-err" style="color:#ff8a8a;font-size:0.84rem;min-height:18px;margin:6px 0 8px"></div>
           <button class="btn-accept" id="accept-btn" onclick="acceptIt()">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
             ${L.acceptBtn}
           </button>
           <button class="btn-pdf" onclick="downloadPdf(this)">${L.printPdf}</button>
           <div><button onclick="declineIt()" id="decline-btn" style="background:none;border:none;color:var(--dim);text-decoration:underline;cursor:pointer;font-size:0.84rem;margin-top:18px;font-family:inherit">${L.declineBtn}</button></div>
           <p style="margin-top:14px">${L.questions}</p>
         </div>`}
  </div>

  <footer>
    <p>incremento<span style="color:var(--lime)">.</span> · ${L.preparedByVal.split('·').pop().trim()} · <a href="https://incremento.co">incremento.co</a></p>
  </footer>
</div>
<script>
const L = ${JSON.stringify({
    nameErr: L.nameErr, agreeErr: L.agreeErr, accepting: L.accepting, tryAgain: L.tryAgain,
    somethingWrong: L.somethingWrong, networkError: L.networkError, declining: L.declining,
    declineConfirm: L.declineConfirm, declineReason: L.declineReason, declineBtn: L.declineBtn,
  })};
/* PDF = the browser's native Print -> "Save as PDF": crisp vector text, true A4.
   (Ask the client to keep "Background graphics" ticked so the dark theme prints.) */
function downloadPdf(){ window.print(); }
if (new URLSearchParams(location.search).get('pdf') === '1') {
  window.addEventListener('load', () => setTimeout(() => window.print(), 500));
}

async function acceptIt() {
  const err = document.getElementById('accept-err');
  const name = (document.getElementById('sig-name').value || '').trim();
  const agree = document.getElementById('agree').checked;
  err.textContent = '';
  if (name.length < 2) { err.textContent = L.nameErr; return; }
  if (!agree) { err.textContent = L.agreeErr; return; }
  const btn = document.getElementById('accept-btn');
  btn.disabled = true; btn.textContent = L.accepting;
  try {
    const res = await fetch(location.pathname + '/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signed_name: name }),
    });
    if (res.ok) { location.reload(); }
    else { const d = await res.json().catch(() => ({})); err.textContent = d.error || L.somethingWrong; btn.disabled = false; btn.textContent = L.tryAgain; }
  } catch { err.textContent = L.networkError; btn.disabled = false; btn.textContent = L.tryAgain; }
}

async function declineIt() {
  if (!confirm(L.declineConfirm)) return;
  const reason = prompt(L.declineReason) || '';
  const btn = document.getElementById('decline-btn');
  btn.disabled = true; btn.textContent = L.declining;
  try {
    const res = await fetch(location.pathname + '/decline', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason }),
    });
    if (res.ok) { location.reload(); }
    else { btn.disabled = false; btn.textContent = L.declineBtn; }
  } catch { btn.disabled = false; btn.textContent = L.declineBtn; }
}
</script>
</body>
</html>`;

  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  } });
}

/* ── Proposal email to client ────────────────────────────── */
const EMAIL_TEMPLATE_DEFAULTS = {
  en: {
    greeting:  'Hi {name},',
    intro:     'It was great to meet and talk through your project. As promised, here is your proposal for {title} - it covers the scope, timeline and investment, and you can accept it online with one click.',
    closing:   'Any questions at all, just hit reply - happy to walk you through it.',
    signature: 'Robin\nIncremento · Lisbon',
    subject:   'Your proposal from Incremento - {title}',
  },
  pt: {
    greeting:  'Olá {name},',
    intro:     'Foi um prazer falar consigo sobre o seu projeto. Conforme combinado, segue a sua proposta para {title} - cobre o âmbito, o calendário e o investimento, e pode aceitá-la online com um único clique.',
    closing:   'Qualquer questão, é só responder a este email - com todo o gosto explico tudo.',
    signature: 'Robin\nIncremento · Lisboa',
    subject:   'A sua proposta da Incremento - {title}',
  },
};

/* Greetings read better with a first name ("Hi Rodolfo,") than the full name. */
function firstNameOf(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

function fillTokens(str, p) {
  return String(str || '')
    .replace(/\{name\}/g, escHtml(firstNameOf(p.client_name)))
    .replace(/\{title\}/g, `<strong style="color:#e0e8f0">${escHtml(p.title || '')}</strong>`)
    .replace(/\{company\}/g, escHtml(p.client_company || ''));
}
function nl2br(str) { return escHtml(str).replace(/\n/g, '<br>'); }

/* Plain-text token fill (for editable fields, no HTML). */
function fillTokensPlain(str, p) {
  return String(str || '')
    .replace(/\{name\}/g, firstNameOf(p.client_name))
    .replace(/\{title\}/g, p.title || '')
    .replace(/\{company\}/g, p.client_company || '');
}

/* The editable intro text for the Send flow: the proposal's own saved intro if
   set, otherwise the template intro with tokens filled in as a starting point. */
async function effectiveIntroText(p, env) {
  let pIntro = '';
  try { pIntro = String(JSON.parse(p.content || '{}').intro || '').trim(); } catch {}
  if (pIntro) return pIntro;
  const t = await getEmailTemplate(env, p.language);
  return fillTokensPlain(t.intro, p);
}

/* The email's opening paragraph: the proposal's own intro (the warm note Robin
   wrote) if present, otherwise the configurable template intro. */
function proposalIntroHtml(p, t) {
  let pIntro = '';
  try { pIntro = String(JSON.parse(p.content || '{}').intro || '').trim(); } catch {}
  return pIntro ? escHtml(pIntro).replace(/\n/g, '<br>') : fillTokens(t.intro, p);
}

function buildProposalEmailHtml(p, link, tpl = {}) {
  const t = { ...(EMAIL_TEMPLATE_DEFAULTS[normLang(p.language)] || EMAIL_TEMPLATE_DEFAULTS.en), ...tpl };
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
            <p style="margin:0 0 14px;font-size:16px;color:#e0e8f0">${fillTokens(t.greeting, p)}</p>
            <p style="margin:0 0 22px;font-size:15px;color:#b0bec8;line-height:1.7">${proposalIntroHtml(p, t)}</p>
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
