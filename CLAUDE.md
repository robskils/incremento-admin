# Incremento Admin Dashboard

Admin panel for incremento.co enquiry management — pipeline, contacts, analytics.

## Stack
- **Frontend:** Plain HTML/CSS/JS in `public/` — deployed to Cloudflare Pages
- **Backend:** Cloudflare Worker at `enquiries.incremento.co`
- **Database:** Cloudflare D1 (`incremento-admin`)
- **Email:** Resend API
- **Auth:** Built-in email OTP login (6-digit code via Resend → 7-day HS256 JWT signed with ADMIN_KEY, sent as `Authorization: Bearer`). Allowed emails in `ADMIN_EMAILS` var in wrangler.toml. Legacy `X-Admin-Key` header still accepted. Auth endpoints: `POST /auth/request-code`, `POST /auth/verify`. OTP codes in D1 `otp_codes` table (10-min expiry). Admin API also routed same-origin at `admin.incremento.co/api/*`.

## Design System
- Background: `#0e1820` (dark midnight)
- Accent lime: `#9EF54A`, Accent cyan: `#5EE7D8`
- Fonts: Space Grotesk (headings) + Inter (body)
- Shared stylesheet: `public/admin.css`
- Shared JS: `public/admin.js`

## Pages
```
public/
  index.html      → redirect to dashboard
  dashboard.html  → KPIs, pipeline funnel, won revenue, service breakdown, monthly chart (analytics merged in)
  inbox.html      → (hidden from nav; still reachable by URL)
  enquiry.html    → full-page enquiry view/edit (?id=N)
  pipeline.html   → stage view + quick stage update
  proposals.html  → proposal list + enquiry picker (AI draft)
  proposal.html   → full-page proposal editor (?id=N edit, ?enquiry=N AI-draft, blank=new)
  contacts.html   → deduplicated contact list
  settings.html   → admin key, editable proposal email template, quick links
  brand.html      → brand assets: logos (light/dark previews + SVG/PNG download), colour swatches (click-copy), guidelines
  brand/          → logo + favicon source files + incremento-brand-pack.zip
  admin.css       → shared dark theme stylesheet
  admin.js        → shared JS (auth, API helpers, utilities)
  favicon.svg     → Incremento icon
```

## Pipeline Stages
`new` → `proposal_sent` → `accepted` → `in_progress` → `completed` / `on_hold` / `cancelled`

## Worker API (all require X-Admin-Key header)
- `POST /`                  → form submission (no auth required, public)
- `GET /api/enquiries`      → list all (supports ?limit=&offset=&stage=)
- `GET /api/enquiries/:id`  → single enquiry
- `PATCH /api/enquiries/:id`→ update stage/notes/value
- `GET /api/stats`          → dashboard KPIs (total, new_count, stage_counts, potential_revenue)
- `POST /api/proposals/draft` → AI-draft proposal from enquiry (body: {enquiry_id}; needs ANTHROPIC_API_KEY secret)
- `GET/POST /api/proposals` + `GET/PATCH /api/proposals/:id` → proposal CRUD
- `POST /api/proposals/:id/send` → email proposal link to client via Resend
- `GET /p/:token` (public) → branded proposal page (records view). `?preview=1` = admin preview (works for drafts, banner, hides Accept, no view recorded). `?pdf=1` = auto-download. Download PDF button uses html2pdf to keep the dark theme; @media print also preserves dark colors.
- `POST /p/:token/accept` (public) → client accepts; emails Robin; enquiry stage → accepted; logs inbound message
- `GET /api/messages?email=` → communication timeline for a contact (merges enquiries + logged messages)
- `POST /api/messages` → manually log a message (direction, subject, body)
- `GET/PATCH /api/settings` → key/value settings (editable proposal email template: proposal_email_intro/closing/signature; tokens {name}{title}{company})

## Communication log (messages table)
Auto-logged: enquiry (inbound), proposal email (outbound), acceptance (inbound). Manual: "Log a message" composer on enquiry.html + proposal.html (shared `mountComms()` in admin.js). Keyed by contact_email. Inbound capture: `POST /api/inbound-email?token=INBOUND_SECRET` (Mailgun webhook, multipart/form-data) — same pattern as lst-pp-admin. Detects direction (INC_SENDERS → outbound), matches contact by email, dedupes, logs kind='mail'. Robin BCCs log@mg.incremento.co / routes replies there via Mailgun. INBOUND_SECRET is a wrangler secret.

## Proposal statuses
`draft` → `sent` → `viewed` → `accepted` / `declined`
Content JSON: intro, scope[{title,description}], deliverables[], timeline[{phase,duration,description}], pricing[{item,description,price}], terms.
AI drafting calls the Claude API (claude-opus-4-8, structured JSON output) directly from the worker.

## Setup (first time)
```bash
# 1. Create D1 database
wrangler d1 create incremento-admin
# Copy the database_id into wrangler.toml

# 2. Run schema
wrangler d1 execute incremento-admin --file worker/schema.sql --remote

# 3. Set secrets
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_KEY

# 4. Deploy worker
wrangler deploy

# 5. Deploy admin pages
wrangler pages deploy ./public --project-name incremento-admin --branch y --commit-dirty=true
```

## Deploy
```bash
wrangler deploy                                                              # worker
wrangler pages deploy ./public --project-name incremento-admin --branch y --commit-dirty=true  # pages (production branch is literally named "y" — without --branch y the deploy lands in Preview and admin.incremento.co won't update)
```

## Related
- `incremento-site` — the public site that submits to this worker
- `lst-pp-admin` — LST/PP admin (reference implementation)

## Admin URL
Set up `admin.incremento.co` as custom domain for the Pages project in Cloudflare dashboard.
Add `https://admin.incremento.co` to `ADMIN_ORIGINS` array in `worker/index.js` after setup.
