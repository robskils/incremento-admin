/* ── Incremento Admin — Shared JS ─────────────────────────── */

/* On admin.incremento.co the API is same-origin (no CORS); anywhere
   else (pages.dev) it goes to the worker's own domain. */
const SAME_ORIGIN = location.hostname === 'admin.incremento.co';
const WORKER = SAME_ORIGIN ? '' : 'https://enquiries.incremento.co';

/* Auth: email OTP login → 7-day session token in localStorage.
   Legacy X-Admin-Key (sessionStorage) still works as a fallback. */
function getToken() { return localStorage.getItem('inc_admin_token') || ''; }
function getKey()   { return sessionStorage.getItem('inc_admin_key') || ''; }

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const token = getToken();
  const key = getKey();
  if (token) h['Authorization'] = 'Bearer ' + token;
  else if (key) h['X-Admin-Key'] = key;
  return h;
}

/* ── API helpers ─────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const res = await fetch(WORKER + path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    localStorage.removeItem('inc_admin_token');
    showLogin();
    throw new Error('Unauthorized');
  }
  return res.json();
}

/* ── Login gate (email → 6-digit code) ───────────────────── */
function loginCardHtml() {
  return `
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:40px;width:100%;max-width:380px;text-align:center">
    <svg width="36" height="36" viewBox="0 0 32 32" fill="none" style="margin:0 auto 16px"><defs><linearGradient id="lgx" x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#9EF54A"/><stop offset="100%" stop-color="#5EE7D8"/></linearGradient></defs><rect x="4" y="20" width="5" height="8" rx="2.5" fill="url(#lgx)" opacity="0.55"/><rect x="12" y="14" width="5" height="14" rx="2.5" fill="url(#lgx)" opacity="0.78"/><rect x="20" y="10" width="5" height="18" rx="2.5" fill="url(#lgx)"/><circle cx="22.5" cy="5.5" r="2.25" fill="url(#lgx)"/></svg>
    <p style="font-family:'Space Grotesk',sans-serif;font-size:1.1rem;font-weight:600;color:var(--text);margin-bottom:6px">incremento<span style="color:var(--lime)">.</span> admin</p>

    <div id="login-step-email">
      <p style="font-size:0.78rem;color:var(--text-dim);margin-bottom:24px">Enter your email — we'll send you a sign-in code</p>
      <input id="login-email" type="email" placeholder="you@incremento.co" autocomplete="email"
        style="width:100%;padding:10px 14px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;font-family:'Inter',sans-serif;font-size:0.88rem;color:var(--text);outline:none;margin-bottom:12px;box-sizing:border-box">
      <button id="login-send" class="btn-primary" style="width:100%;justify-content:center">Send code</button>
    </div>

    <div id="login-step-code" style="display:none">
      <p style="font-size:0.78rem;color:var(--text-dim);margin-bottom:24px">We emailed a 6-digit code to <strong id="login-email-echo" style="color:var(--text)"></strong></p>
      <input id="login-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="• • • • • •" maxlength="6"
        style="width:100%;padding:12px 14px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;font-family:'Space Grotesk',monospace;font-size:1.3rem;letter-spacing:0.4em;text-align:center;color:var(--text);outline:none;margin-bottom:12px;box-sizing:border-box">
      <button id="login-verify" class="btn-primary" style="width:100%;justify-content:center">Sign in</button>
      <button id="login-back" style="background:none;border:none;color:var(--text-dim);font-size:0.74rem;margin-top:12px;cursor:pointer;font-family:'Inter',sans-serif">Use a different email</button>
    </div>

    <p id="login-error" style="display:none;font-size:0.76rem;color:#ef4444;margin-top:14px"></p>
  </div>`;
}

function showLogin() {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  if (!overlay.dataset.otpReady) initLoginUI(overlay);
  overlay.style.display = 'flex';
}

function loginError(msg) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function initLoginUI(overlay) {
  overlay.innerHTML = loginCardHtml();
  overlay.dataset.otpReady = '1';

  const emailInput = document.getElementById('login-email');
  const codeInput  = document.getElementById('login-code');
  const sendBtn    = document.getElementById('login-send');
  const verifyBtn  = document.getElementById('login-verify');
  let email = '';

  async function sendCode() {
    email = emailInput.value.trim().toLowerCase();
    if (!email) return;
    loginError('');
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      const res = await fetch(WORKER + '/auth/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send code');
      document.getElementById('login-step-email').style.display = 'none';
      document.getElementById('login-step-code').style.display = 'block';
      document.getElementById('login-email-echo').textContent = email;
      codeInput.focus();
    } catch (err) {
      loginError(err.message);
    }
    sendBtn.disabled = false; sendBtn.textContent = 'Send code';
  }

  async function verifyCode() {
    const code = codeInput.value.trim();
    if (code.length !== 6) { loginError('Enter the 6-digit code'); return; }
    loginError('');
    verifyBtn.disabled = true; verifyBtn.textContent = 'Checking…';
    try {
      const res = await fetch(WORKER + '/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || 'Sign-in failed');
      localStorage.setItem('inc_admin_token', data.token);
      sessionStorage.removeItem('inc_admin_key');
      window.location.reload();
    } catch (err) {
      loginError(err.message);
      verifyBtn.disabled = false; verifyBtn.textContent = 'Sign in';
    }
  }

  sendBtn.addEventListener('click', sendCode);
  emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
  verifyBtn.addEventListener('click', verifyCode);
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
  codeInput.addEventListener('input', () => { if (codeInput.value.trim().length === 6) verifyCode(); });
  document.getElementById('login-back').addEventListener('click', () => {
    document.getElementById('login-step-code').style.display = 'none';
    document.getElementById('login-step-email').style.display = 'block';
    loginError('');
    emailInput.focus();
  });
}

function initLogin() {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  if (getToken() || getKey()) { overlay.style.display = 'none'; return; }
  showLogin();
}

/* ── Inbox badge (shown in sidebar) ─────────────────────── */
async function loadNavBadge() {
  try {
    const data = await apiFetch('/api/stats');
    const badge = document.getElementById('nav-badge');
    if (badge && data.new_count > 0) {
      badge.textContent = data.new_count;
      badge.style.display = 'inline';
    }
  } catch {}
}

/* ── Utility: relative time ──────────────────────────────── */
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7)   return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}

/* ── Stage helpers ───────────────────────────────────────── */
const STAGE_LABELS = {
  new:          'New',
  proposal_sent:'Proposal Sent',
  accepted:     'Accepted',
  in_progress:  'In Progress',
  completed:    'Completed',
  on_hold:      'On Hold',
  cancelled:    'Cancelled',
};
const STAGE_CSS = {
  new:          'stage-new',
  proposal_sent:'stage-proposal',
  accepted:     'stage-accepted',
  in_progress:  'stage-in_progress',
  completed:    'stage-completed',
  on_hold:      'stage-on_hold',
  cancelled:    'stage-cancelled',
};
const STAGE_COLORS = {
  new:          '#5EE7D8',
  proposal_sent:'#f59e0b',
  accepted:     '#9EF54A',
  in_progress:  '#22c55e',
  completed:    '#22c55e',
  on_hold:      '#94a3b8',
  cancelled:    '#ef4444',
};

function stageBadge(stage) {
  return `<span class="stage-badge ${STAGE_CSS[stage] || 'stage-new'}">${STAGE_LABELS[stage] || stage}</span>`;
}

function interestPills(interests) {
  if (!interests) return '';
  const arr = typeof interests === 'string' ? JSON.parse(interests) : interests;
  return arr.map(i => `<span class="interest-pill">${i.replace(/-/g,' ')}</span>`).join(' ');
}

/* ── Quotes ──────────────────────────────────────────────── */
const QUOTES = [
  { text: 'The best way to predict the future is to build it.', cite: '— Peter Drucker' },
  { text: 'Simplicity is the ultimate sophistication.', cite: '— Leonardo da Vinci' },
  { text: 'Make it work, make it right, make it fast.', cite: '— Kent Beck' },
  { text: 'Design is not just what it looks like. Design is how it works.', cite: '— Steve Jobs' },
  { text: 'Move fast with stable infrastructure.', cite: '— Incremento' },
  { text: 'Every great design begins with an even better story.', cite: '— Lorinda Mamo' },
];
function renderQuote() {
  const q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  const el = document.getElementById('dash-quote');
  const ce = document.getElementById('dash-cite');
  if (el) el.textContent = `"${q.text}"`;
  if (ce) ce.textContent = q.cite;
}

document.addEventListener('DOMContentLoaded', () => {
  initLogin();
  loadNavBadge();
  renderQuote();
});

/* ── Communication history (Contact & Proposal pages) ─────── */
function commsEscape(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const COMMS_META = {
  enquiry:  { label: 'Enquiry',          color: 'var(--cyan)'  },
  email:    { label: 'Proposal email',   color: 'var(--lime)'  },
  mail:     { label: 'Email',            color: 'var(--cyan)'  },
  accepted: { label: 'Accepted',         color: 'var(--lime)'  },
  note:     { label: 'Logged message',   color: 'var(--slate)' },
};

async function mountComms(container, opts) {
  const email = (opts.email || '').trim();
  if (!email) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div class="panel" style="padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div class="detail-label" style="margin:0">Communication history</div>
        <button class="btn-ghost" id="comms-log-toggle" style="font-size:0.72rem;padding:5px 10px">+ Log a message</button>
      </div>
      <div id="comms-composer" style="display:none;margin-bottom:16px;padding:14px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px">
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <select id="comms-dir" class="stage-select" style="flex:0 0 150px">
            <option value="inbound">From client</option>
            <option value="outbound">To client</option>
          </select>
          <input id="comms-subj" class="value-input" placeholder="Subject (optional)" style="flex:1">
        </div>
        <textarea id="comms-body" class="notes-textarea" rows="3" placeholder="What was said…"></textarea>
        <div style="text-align:right;margin-top:8px">
          <button class="btn-primary" id="comms-save" style="font-size:0.78rem;padding:7px 14px">Save to history</button>
        </div>
      </div>
      <div id="comms-list"><div class="empty-state" style="padding:24px">Loading…</div></div>
    </div>`;

  const listEl = container.querySelector('#comms-list');

  async function refresh() {
    try {
      const data = await apiFetch('/api/messages?email=' + encodeURIComponent(email));
      const msgs = (data.messages || []);
      if (!msgs.length) {
        listEl.innerHTML = '<div class="empty-state" style="padding:24px">No messages yet</div>';
        return;
      }
      listEl.innerHTML = msgs.map(m => {
        const meta = COMMS_META[m.kind] || COMMS_META.note;
        const inbound = m.direction === 'inbound';
        // Two-colour thread: client = cyan (left), Incremento = lime (right)
        const who    = inbound ? 'Client' : 'Incremento';
        const accent = inbound ? '#5EE7D8' : '#9EF54A';
        const bg     = inbound ? 'rgba(94,231,216,0.09)' : 'rgba(158,245,74,0.09)';
        const border = inbound ? 'rgba(94,231,216,0.38)' : 'rgba(158,245,74,0.38)';
        const align  = inbound ? 'flex-start' : 'flex-end';
        return `
          <div style="display:flex;justify-content:${align};margin:10px 0">
            <div style="max-width:80%;min-width:0;background:${bg};border:1px solid ${border};border-radius:12px;padding:10px 14px">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px">
                <span style="font-size:0.72rem;font-weight:600;color:${accent}">${who}</span>
                <span style="font-size:0.66rem;color:var(--text-dim)">${meta.label}</span>
                ${m.source==='manual'?'<span style="font-size:0.62rem;color:var(--text-dim);border:1px solid var(--border2);border-radius:10px;padding:1px 6px">logged</span>':''}
                <span style="font-size:0.66rem;color:var(--text-dim);margin-left:auto">${timeAgo(m.created_at)}</span>
              </div>
              ${m.subject?`<div style="font-size:0.86rem;font-weight:500;color:var(--text)">${commsEscape(m.subject)}</div>`:''}
              ${m.body?`<div style="font-size:0.82rem;color:var(--text-sub);line-height:1.5;white-space:pre-wrap;margin-top:2px">${commsEscape(m.body)}</div>`:''}
            </div>
          </div>`;
      }).join('');
    } catch {
      listEl.innerHTML = '<div class="empty-state" style="padding:24px">Failed to load history</div>';
    }
  }

  container.querySelector('#comms-log-toggle').addEventListener('click', () => {
    const c = container.querySelector('#comms-composer');
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
  });

  container.querySelector('#comms-save').addEventListener('click', async () => {
    const btn = container.querySelector('#comms-save');
    const body = container.querySelector('#comms-body').value.trim();
    const subj = container.querySelector('#comms-subj').value.trim();
    if (!body && !subj) return;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await apiFetch('/api/messages', { method:'POST', body: JSON.stringify({
        contact_email: email,
        enquiry_id: opts.enquiry_id || null,
        proposal_id: opts.proposal_id || null,
        direction: container.querySelector('#comms-dir').value,
        subject: subj, body,
      })});
      container.querySelector('#comms-body').value = '';
      container.querySelector('#comms-subj').value = '';
      container.querySelector('#comms-composer').style.display = 'none';
      await refresh();
    } catch { alert('Could not save message'); }
    btn.disabled = false; btn.textContent = 'Save to history';
  });

  await refresh();
}
