/* ── Incremento Admin — Shared JS ─────────────────────────── */

const WORKER = 'https://enquiries.incremento.co';

/* Admin key — stored in sessionStorage after login */
function getKey() { return sessionStorage.getItem('inc_admin_key') || ''; }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-Admin-Key': getKey() };
}

/* ── API helpers ─────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const res = await fetch(WORKER + path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  return res.json();
}

/* ── Login gate ──────────────────────────────────────────── */
function showLogin() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function initLogin() {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  const btn = document.getElementById('login-btn');
  const input = document.getElementById('login-key');
  if (getKey()) { overlay.style.display = 'none'; return; }
  overlay.style.display = 'flex';
  btn.addEventListener('click', () => {
    const key = input.value.trim();
    if (!key) return;
    sessionStorage.setItem('inc_admin_key', key);
    overlay.style.display = 'none';
    window.location.reload();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
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
  qualifying:   'Qualifying',
  proposal_sent:'Proposal Sent',
  accepted:     'Accepted',
  in_progress:  'In Progress',
  completed:    'Completed',
  on_hold:      'On Hold',
  cancelled:    'Cancelled',
};
const STAGE_CSS = {
  new:          'stage-new',
  qualifying:   'stage-qualifying',
  proposal_sent:'stage-proposal',
  accepted:     'stage-accepted',
  in_progress:  'stage-in_progress',
  completed:    'stage-completed',
  on_hold:      'stage-on_hold',
  cancelled:    'stage-cancelled',
};
const STAGE_COLORS = {
  new:          '#5EE7D8',
  qualifying:   '#60a5fa',
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
