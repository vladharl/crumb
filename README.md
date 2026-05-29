# Crumb

> Follow the trail.

Open-source B2B feedback platform. Customers drop feedback inside your product; you triage, reply, ship — all in one continuous loop. Self-host it, or use the paid hosted tier when it's ready.

This repo is **early**. The frontend dashboard and the start of the API + data model are in; widget, auth, Slack, and the docker self-host story for the dashboard itself come next.

## What's here

```
crumb/
├── apps/
│   ├── dashboard/      # Next.js dashboard (vendor side) + public /api/v1
│   └── widget/         # The customer-facing embed (vanilla TS → IIFE)
└── packages/
    ├── db/             # Drizzle schema + Postgres client + seed
    └── ui/             # Shared design system (icons, atoms, status)
```

Future: magic-link auth, Slack integration, dashboard Dockerfile for self-host.

## Run locally

You need **Node 20+**, **pnpm 11+**, and **Docker** (for Postgres).

```bash
pnpm install
pnpm db:up         # boots Postgres 16 in docker on :5432
pnpm db:push       # applies the schema
pnpm db:seed       # populates one workspace (northbeam) with sample data
pnpm widget:build  # builds the embed widget → apps/dashboard/public/widget.js
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
pnpm dev           # → http://localhost:3000
```

The dashboard requires login. On a fresh DB, open **http://localhost:3000** and you'll be sent through `/onboard` to create the first workspace + admin. After `pnpm db:seed`, log in at **http://localhost:3000/login** as any seeded admin (e.g. `lina@northbeam.io`). Magic links go to whichever email provider is configured — by default that's stdout (read from the dev terminal or `docker compose logs dashboard`); set `CRUMB_EMAIL_PROVIDER=resend` for real delivery, see [Email delivery](#email-delivery). A 7-day session cookie is set; sign out clears it.

### Self-host vs. Crumb Cloud

Crumb ships from one repo to two deployment shapes — same code, env-gated:

| Capability | Self-host (default) | Crumb Cloud |
| --- | --- | --- |
| Submit / triage / reply / status flow | ✅ | ✅ |
| Magic-link auth | ✅ | ✅ |
| Embed widget | ✅ | ✅ |
| Magic-link emails (managed delivery) | stdout only | Resend (or other provider) |
| Vendor-side Slack notifications | BYO Slack app | one-click OAuth |
| Linear / Jira / GitHub ticket sync | BYO OAuth apps | one-click OAuth |
| AI initiative clustering | gated | included |
| Session Record (rrweb capture + in-thread replay) | gated | included |

Self-host is free and AGPL. The hosted tier at **[usecrumb.xyz](https://usecrumb.xyz)** runs the same source with `CRUMB_TIER=cloud` plus the API keys we hold so you don't have to.

To run as Cloud yourself (e.g. for the hosted deployment):

```bash
CRUMB_TIER=cloud
RESEND_API_KEY=re_xxxxxxxxxxxx
CRUMB_EMAIL_FROM="Crumb <crumb@usecrumb.xyz>"
# Slack / Linear / etc. credentials as added later
```

### Email delivery

Magic-link emails (and the rest of the transactional emails) route through a pluggable provider. By default Crumb logs them to stdout — fine for dev, useless for a public deploy. Two real-provider options ship today.

**SMTP** — works against Postmark, SendGrid, SES, Mailgun, or self-hosted Postfix. Free on both tiers; bring your own relay credentials:

```bash
CRUMB_EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587            # 465 for implicit TLS
# SMTP_SECURE=true       # set when using 465
SMTP_USER=your-token
SMTP_PASS=your-token
CRUMB_EMAIL_FROM="Crumb <crumb@yourdomain.com>"
```

**Resend** (Cloud-only) — managed; we hold the API key:

```bash
CRUMB_TIER=cloud
CRUMB_EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxx
CRUMB_EMAIL_FROM="Crumb <crumb@yourdomain.com>"
```

Any sender domain you use must have SPF/DKIM set up at the provider first or messages won't deliver.

### Inbound email replies

When a vendor replies to a thread, the customer gets an email. Without inbound wiring, that email goes out from a `noreply@…` address. To let customers reply by email and land back on the thread:

```bash
CRUMB_INBOUND_DOMAIN=reply.yourdomain.com
CRUMB_INBOUND_SECRET=optional_shared_secret   # protects the webhook
```

The dashboard exposes `POST /api/v1/inbound/reply` accepting a generic JSON shape (`{ to, from, text, subject? }`). Point your provider's inbound parser at that endpoint (Resend Inbound, SendGrid Inbound Parse, Postmark, or a Mailgun route all work). The Reply-To on every notification is `reply+<shortId>.<token>@<CRUMB_INBOUND_DOMAIN>`, signed with the workspace's signing secret.

### Subscription billing (Cloud)

Crumb Cloud monetizes via Stripe — same source code as self-host, an extra wiring layer for paying customers. Self-host doesn't show any billing UI (the `/settings/billing` page renders the AGPL "you're free" copy).

To wire Stripe on a Cloud deployment:

```bash
CRUMB_TIER=cloud
STRIPE_SECRET_KEY=sk_live_…       # or sk_test_… in test mode
STRIPE_PRICE_ID=price_…           # the price your Checkout sells
STRIPE_WEBHOOK_SECRET=whsec_…     # from "Add endpoint" in the Stripe dashboard
# Optional:
STRIPE_PORTAL_RETURN_URL=https://dashboard.usecrumb.xyz/settings/billing
```

Then point a Stripe webhook endpoint at `/api/v1/stripe/webhook` and subscribe to:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

The handler keeps each workspace's `plan_id`, `subscription_status`, `seats`, `current_period_end` in sync with Stripe. Workspace admins click **Upgrade** to land on a Stripe-hosted Checkout, then **Manage subscription** to open the Customer Portal for invoices, card updates, or cancellation. Identity/entitlement gates that depend on plan live behind `isActiveStatus()` in `apps/dashboard/lib/stripe.ts`.

### Rate limiting

Public-API POST endpoints (`/api/v1/items`, `/api/v1/items/[shortId]`, `/api/v1/uploads`, `/api/v1/inbound/reply`) are rate-limited per source IP using an in-memory token bucket. Defaults:

```bash
CRUMB_RATE_LIMIT_CAPACITY=60          # tokens per bucket
CRUMB_RATE_LIMIT_REFILL_PER_SEC=1     # tokens per second
```

Exhausted buckets return `429 rate_limited` with a `Retry-After` header. The limiter is process-local — fine for single-VM self-host. Cloud multi-instance swaps in a Redis-backed implementation behind the same helper.

### Slack notifications

Workspace admins can connect Slack from **Settings → Integrations** to DM teammates when a customer replies — instead of (or in addition to, on a per-user basis) email. Each member picks their delivery channel under **Notifications → Preferences**; Slack falls back to email if the lookup or DM send fails, so customer replies never go silently dropped.

Cloud comes with a Slack app registered. Self-host needs to bring its own — set:

```bash
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
```

Then register a Slack app at [api.slack.com/apps](https://api.slack.com/apps) with bot scopes `chat:write`, `im:write`, `users:read`, `users:read.email` and redirect URL `{dashboard origin}/api/integrations/slack/callback`. Optional: `SLACK_REDIRECT_URL` if the dashboard sits behind a proxy that mangles `x-forwarded-host`; `SLACK_STATE_SECRET` if you want a dedicated HMAC key for the OAuth `state` (otherwise falls back to `CRUMB_INBOUND_SECRET`, then `SLACK_CLIENT_SECRET`).

Slack user lookups are by email — each workspace member is matched once to their Slack `user_id` and cached on first DM. Failed lookups (member's Slack email doesn't match their Crumb email) are retried after 24h.

### Engineering integrations

Push Crumb items out as **Linear / Jira / GitHub** tickets from the thread sidebar. Status syncs back via webhook (one-way, provider is canonical for engineering status; Crumb is canonical for the vendor↔customer relationship). On Cloud with `ANTHROPIC_API_KEY` set, the modal also offers **Suggest with AI** — drafts a title + body matched to your team's voice using up to 10 recent ticket titles from the target, plus (if a GitHub repo is connected on the workspace) the repo's README + top-level tree as project context for any provider's draft.

Cloud comes with all three apps registered. Self-host BYO. See `apps/dashboard/.env.local.example` for the full env stanzas; the short version:

- **Linear**: register an OAuth app at `linear.app/settings/api` → `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` (+ optional `LINEAR_WEBHOOK_SECRET`). Redirect URL: `{dashboard origin}/api/integrations/linear/callback`.
- **Jira**: register a 3LO app at `developer.atlassian.com` with scopes `read:jira-work write:jira-work read:jira-user offline_access` → `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` (+ `JIRA_WEBHOOK_SECRET`). Atlassian's per-tenant `cloud_id` is discovered automatically + re-checked on every token refresh so reinstalls against a different site don't silently 404.
- **GitHub**: register a GitHub App (not an OAuth App) at `github.com/settings/apps` with permissions `Issues:rw + Contents:r + Metadata:r` and the `Issues` event → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (PEM), plus `GITHUB_WEBHOOK_SECRET`. Installation tokens are minted per-call from the App's JWT and cached in module memory for 50 minutes.

Webhook URLs (configure inside each provider's app settings):

```
{dashboard origin}/api/integrations/linear/webhook
{dashboard origin}/api/integrations/jira/webhook
{dashboard origin}/api/integrations/github/webhook
```

What this **does not** do: write Crumb status changes back to the provider, mirror comments/attachments, support multi-tracker links per item, or read deep repo code (README + tree only). See the phase plan for the deferred list.

### AI initiative clustering

Once a workspace has at least one Initiative, Crumb Cloud can auto-suggest which Initiative new feedback belongs to. Vendors review the guess inline — one click accepts, one click dismisses. Cloud-only; self-host stays untouched.

```bash
CRUMB_TIER=cloud
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx
```

Behaviour:
- **On every new item**: `POST /api/v1/items` fires a background classification against the workspace's non-parked initiatives. If the model picks one with confidence > 0.55, a pending suggestion is stored. The customer never waits — the API responds before the LLM call.
- **Inbox**: items with a pending suggestion show an `✨ User Management ✓ ✗` chip in the Initiative column. Hover shows the model's one-line reason + confidence.
- **Thread sidebar**: under the Initiative card, an "AI suggests" panel appears when nothing's set yet — same accept/dismiss controls.
- **Bulk**: select unclassified items in the inbox and click **Cluster selected** to batch-classify (capped at 25 per click to keep costs bounded).

Uses Claude Haiku 4.5 — fast and cheap (~$0.001 per item). Accepted/dismissed history is kept so a later model rerun can supersede an earlier dismissal.

### Session record (Cloud)

When a customer drops feedback through the widget, Crumb Cloud can attach a video-like replay of the last few minutes of their session — so the vendor sees what they were actually doing, not just what they wrote. Built on [rrweb](https://github.com/rrweb-io/rrweb) (MIT). Cloud-only.

Enable per-workspace at **Settings → Integrations → Session record**. When on, the widget injects a second small bundle (`/widget-record.js`) after `/me` resolves; the launcher itself stays lean. Captured chunks flush every ~5s via `fetch`, with a `sendBeacon` final-flush on `pagehide`.

Privacy defaults (locked-in, not configurable in v1):
- All `<input>` values are masked.
- `password` / `email` input types are hard-blocked.
- The Crumb widget itself is blocked from recording (no recursive UI).
- Vendors can opt out customer-side via `class="crumb-block"` (skip whole subtree) or `class="crumb-mask"` (mask text).

Cost guard-rails (capped per session):
- 10 MB of events
- 5,000 events
- 30 minutes

The recorder stops itself client-side at each cap; the server returns 413 if exceeded. Sessions are linked to a feedback item only after the customer submits with ≥1 chunk flushed — empty sessions stay orphan and can be swept later. v1 keeps sessions forever; per-plan retention is a follow-up.

**CSP gotcha:** if the customer's site uses `script-src 'self'`, the recorder script tag won't load. Allow your Crumb origin in `script-src` to enable session record on that site.

**Pruning orphan sessions:** sessions where the customer never submitted feedback sit around indefinitely without a sweep. Set `CRUMB_INTERNAL_SWEEP_SECRET=<random>` and POST to `/api/v1/internal/replay-sweep` with header `X-Crumb-Sweep-Secret: <random>` from your cron. Defaults: prune `item_id IS NULL` sessions older than 24h, 500 rows per call. Response includes `{ deletedSessions, deletedChunks, releasedBytes }`.

### Try the embed widget

Open **http://localhost:3000/widget-demo.html** — a mock analytics dashboard with Crumb's launcher in the bottom-right.

Customer side (in the widget):
1. Click the launcher → drop a crumb (bug / idea / question + title + details).
2. The confirm screen has a "See your feedback" button — opens the customer's inbox.
3. Click any item to read the thread, see vendor replies, and reply back inline.

Vendor side (in the dashboard):
4. Reload **/inbox** — the new item is at the top. Click in.
5. Type a reply or move it through the status flow.
6. Reload the widget — the vendor reply is now visible to the customer.

To embed it in your own product:

```html
<script src="https://your-crumb-host/widget.js"
        data-workspace="northbeam"
        data-user-email="user@theircompany.com"
        data-user-name="User Name"
        data-account-name="Their Company"
        defer></script>
```

(Auth is on the roadmap — the next version will require a signed JWT instead of trusting `data-*`.)

### Public API

| Method | Path                                  | What it does                                     |
| ------ | ------------------------------------- | ------------------------------------------------ |
| `POST` | `/api/v1/items`                       | Create an item; auto-creates account + user      |
| `GET`  | `/api/v1/items?workspace&email`       | List the calling customer's submissions          |
| `GET`  | `/api/v1/items/[shortId]?workspace&email` | Read a thread (only if the caller submitted it) |
| `POST` | `/api/v1/items/[shortId]`             | Customer reply on a thread                       |

All endpoints CORS-enabled (`Access-Control-Allow-Origin: *`) until auth narrows it down per-workspace.

### Try the create endpoint directly

The embedded widget will POST to `/api/v1/items`. You can hit it manually right now:

```bash
curl -X POST http://localhost:3000/api/v1/items \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_slug": "northbeam",
    "account_user_email": "you@yourco.com",
    "account_user_name": "You",
    "account_name": "Your Co",
    "type": "idea",
    "title": "A short title",
    "body": "Optional longer body"
  }'
```

Reload `/inbox` and the item is there. Click in to reply or move it through the status flow.

### Useful commands

| Script             | What it does                                      |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | Next.js dev server                                |
| `pnpm build`       | Next.js production build                          |
| `pnpm db:up`       | Start the Postgres container                      |
| `pnpm db:down`     | Stop the Postgres container (data persists)       |
| `pnpm db:push`     | Sync schema → DB (Drizzle Kit, dev only)          |
| `pnpm db:seed`     | Reseed sample data (wipes existing rows first)    |
| `pnpm db:studio`   | Open Drizzle Studio against the local DB          |
| `pnpm widget:build`| Build the embed widget bundle                     |
| `pnpm widget:dev`  | Rebuild the widget on save (esbuild watch)        |

## Self-host

The whole stack — Postgres + the dashboard + the widget bundle it serves — runs from one compose file. From a fresh checkout:

```bash
docker compose up -d --build
```

This builds the dashboard image, brings Postgres up, waits for it to be healthy, then starts the dashboard. The container runs SQL migrations on each startup before booting the server. Visit `http://localhost:3000`.

Override anything via env or a `.env` file at the repo root:

| Var                    | Default        | What it does                                                |
| ---------------------- | -------------- | ----------------------------------------------------------- |
| `POSTGRES_USER`        | `crumb`        | Postgres role                                               |
| `POSTGRES_PASSWORD`    | `crumb`        | Postgres password                                           |
| `POSTGRES_DB`          | `crumb`        | Postgres database name                                      |
| `POSTGRES_PORT`        | `5432`         | Host port for Postgres                                      |
| `DASHBOARD_PORT`       | `3000`         | Host port for the dashboard                                 |
| `CRUMB_WORKSPACE_SLUG` | `northbeam`    | Workspace the dashboard renders (until auth lands)          |
| `CRUMB_SKIP_MIGRATIONS`| _(unset)_      | Set to `1` to skip the migrate step on container startup    |

To seed sample data into a fresh self-hosted deploy:

```bash
docker compose exec dashboard sh -c "node packages/db/dist/migrate.mjs && true"   # already ran via entrypoint
# Then from your host (need pnpm available):
DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb pnpm db:seed
```

For a real deployment, point `DATABASE_URL` at your own managed Postgres and skip the `postgres` service.

The hosted tier (when it ships) runs the same code with auth, billing, and AI clustering layered on top.

## License

AGPL-3.0. If you offer Crumb as a service to others, the source of your fork has to stay open. Self-hosting for your own company is fully permitted.
