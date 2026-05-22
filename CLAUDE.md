# Incremento Admin Dashboard

Admin panel for incremento.co enquiry management — pipeline, contacts, analytics.

## Stack
- **Frontend:** Plain HTML/CSS/JS in `public/` — deployed to Cloudflare Pages
- **Backend:** Cloudflare Worker at `enquiries.incremento.co`
- **Database:** Cloudflare D1 (`incremento-admin`)
- **Email:** Resend API
- **Auth:** Cloudflare Access (email OTP) for the Pages site + `X-Admin-Key` header for API

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
  dashboard.html  → KPIs, pipeline funnel, recent enquiries
  inbox.html      → all enquiries with filter/search + edit modal
  pipeline.html   → stage view + quick stage update
  contacts.html   → deduplicated contact list
  analytics.html  → stage bars, service interest, monthly chart
  settings.html   → admin key, quick links, about
  admin.css       → shared dark theme stylesheet
  admin.js        → shared JS (auth, API helpers, utilities)
  favicon.svg     → Incremento icon
```

## Pipeline Stages
`new` → `qualifying` → `proposal_sent` → `accepted` → `in_progress` → `completed` / `on_hold` / `cancelled`

## Worker API (all require X-Admin-Key header)
- `POST /`                  → form submission (no auth required, public)
- `GET /api/enquiries`      → list all (supports ?limit=&offset=&stage=)
- `GET /api/enquiries/:id`  → single enquiry
- `PATCH /api/enquiries/:id`→ update stage/notes/value
- `GET /api/stats`          → dashboard KPIs (total, new_count, stage_counts, potential_revenue)

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
wrangler pages deploy ./public --project-name incremento-admin --commit-dirty=true
```

## Deploy
```bash
wrangler deploy                                                              # worker
wrangler pages deploy ./public --project-name incremento-admin --commit-dirty=true  # pages
```

## Related
- `incremento-site` — the public site that submits to this worker
- `lst-pp-admin` — LST/PP admin (reference implementation)

## Admin URL
Set up `admin.incremento.co` as custom domain for the Pages project in Cloudflare dashboard.
Add `https://admin.incremento.co` to `ADMIN_ORIGINS` array in `worker/index.js` after setup.
