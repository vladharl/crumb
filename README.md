# Crumb

> Follow the trail.

**Crumb is the feedback loop for product teams.** Customers drop feedback without leaving your product. You triage it, tie it to the accounts and revenue behind it, ship, and tell them when it's done. One continuous loop, no spreadsheets and no screenshot-and-forget forms.

Built for product and solutions teams tired of watching feedback vanish into a black hole. Open source · cloud or self-hosted.

## Why product teams use Crumb

- **Capture in context, not in a form.** Customers send a bug, idea, or question from inside your app through an embedded widget, with their account and session already attached. No more "which workspace, which page, which build?"
- **Prioritize by revenue, not by volume.** Every item is tied to an account and its ARR, so you see the dollars behind a request instead of a raw upvote count.
- **Close the loop automatically.** Reply in-thread or move an item through your status flow, and the customer hears back, by email or in the widget. It's the step most feedback tools quietly skip.
- **A roadmap customers can actually see.** Group feedback into initiatives, make them public, and let accounts follow Now / Next / Later and get notified when something they asked for ships.
- **Ship to where engineering already lives.** Push an item to Linear, Jira, or GitHub as a ticket drafted by AI from the feedback plus your repo context, then sync status back.
- **Let AI handle the triage grunt-work.** New feedback is auto-clustered into the right initiative, so your inbox starts organizing itself.
- **Ask your feedback in plain English.** "What do our highest-ARR accounts keep asking for?" gets an answer grounded in the actual submissions, with citations back to them.

## See it in action

Crumb shortens the feedback loop in three steps: from a customer's note to your roadmap to a shipped fix.

### 1 · Your customer drops feedback in-product, and watches the roadmap

A customer hits the embedded widget without leaving your app, shares an idea, and follows the public roadmap.

![Customer submits feedback via the widget and sees the public roadmap](docs/assets/gifs/act1-customer.gif)

### 2 · You reply and put it on the roadmap they can see

The feedback lands in your inbox. You answer the customer, then flip the initiative public so every account can follow along.

![Vendor replies in the thread and makes the initiative public on the roadmap](docs/assets/gifs/act2-vendor-loop.gif)

### 3 · Prioritize by revenue, ship to engineering

See the ARR behind each ask, then push it to Linear as a ticket drafted from the feedback and your GitHub repo context.

![Vendor prioritizes by ARR and the feedback becomes a linked Linear ticket](docs/assets/gifs/act3-prioritize-ship.gif)

> A polished 90-second cut of all three acts lives at `demos/out/landing.{mp4,webm}`.

These are generated from the seeded app, so they stay in sync with the UI. Regenerate the GIFs, screenshots, and landing video with `pnpm --filter @crumb/demos all` (see [demos/README.md](demos/README.md)). _(Images appear once generated and committed.)_

## What's here

```
crumb/
├── apps/
│   ├── dashboard/      # Next.js dashboard (vendor side) + public /api/v1
│   └── widget/         # The customer-facing embed (vanilla TS → IIFE)
├── packages/
│   ├── db/             # Drizzle schema + Postgres client + seed
│   └── ui/             # Shared design system (icons, atoms, status)
└── demos/              # Playwright → Remotion demo pipeline (GIFs, PNGs, video)
```

On the roadmap: two-way status sync with engineering trackers (today it's one-way — Crumb reads engineering status back but doesn't push Crumb status changes out) and multiple linked tickets per item.

## Run locally

You need **Node 22+**, **pnpm 11+**, and **Docker** (for Postgres).

```bash
pnpm install
pnpm db:up         # boots Postgres 16 (with pgvector) in docker on :5432
export DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb
pnpm db:migrate    # applies the migrations, which also create the pgcrypto + vector extensions
pnpm db:seed       # populates one workspace (southbeam) with sample data
pnpm widget:build  # builds the embed widget → apps/dashboard/public/widget.js
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
pnpm dev           # → http://localhost:3000
```

The dashboard requires login, and sign-in is invite-only. There are two first-run paths, pick one:
- **Fresh / empty DB** (skip `pnpm db:seed`): mint a one-time setup link with `CRUMB_APP_URL=http://localhost:3000 pnpm --filter @crumb/db cli setup-link`, open it, and create the first workspace and its admin. The link works once and expires after 60 minutes. Opening `/onboard` without a link explains how to get one.
- **Seeded demo** (`pnpm db:seed`): log in at **http://localhost:3000/login** as a seeded admin (e.g. `lina@southbeam.io`); the seed creates the `southbeam` workspace + sample data. Magic links go to whichever email provider is configured, by default stdout (read from the dev terminal or `docker compose logs dashboard`); set `CRUMB_EMAIL_PROVIDER=smtp` (or `resend` with `CRUMB_TIER=cloud`) for real delivery, see [Email delivery](#email-delivery). A 7-day session cookie is set; sign out clears it.

### Self-host vs. Crumb Cloud

Crumb ships from one repo to two deployment shapes — a **community** build for self-host and a **cloud** build for the hosted tier:

| Capability | Self-host (default) | Crumb Cloud |
| --- | --- | --- |
| Submit / triage / reply / status flow | ✅ | ✅ |
| Magic-link auth | ✅ | ✅ |
| Embed widget | ✅ | ✅ |
| Inbound email (reply-by-email + forward-to-capture) | ✅ | ✅ |
| Magic-link emails (managed delivery) | stdout only | Resend (or other provider) |
| Vendor-side Slack notifications | BYO Slack app | one-click OAuth · Team plan |
| Microsoft Teams notifications | webhook URL | webhook URL |
| Linear / Jira / GitHub ticket sync | BYO OAuth apps | one-click OAuth · Team plan |
| CRM account + ARR sync (HubSpot / Salesforce) | BYO OAuth apps | one-click OAuth · Team plan |
| Insights — usage analytics & churn signals | ✅ | ✅ (AI-enriched) |
| AI initiative clustering | — (Cloud-only) | Team plan |
| AI ticket drafting (Linear / Jira / GitHub) | — (Cloud-only) | Team plan |
| Ask your feedback (plain-English Q&A) | — (Cloud-only) | Team plan |
| Slack request sizing (@mention → ARR + scope reply) | — (Cloud-only) | Team plan |
| Session Record (rrweb capture + in-thread replay) | — (Cloud-only) | Growth plan |

Self-host is free and AGPL. The hosted tier is live at **[crumb-app.localhostlabs.net](https://crumb-app.localhostlabs.net)** (the marketing site is [crumb.localhostlabs.net](https://crumb.localhostlabs.net)) — it runs the same source built as the `cloud` edition, plus the API keys we hold so you don't have to.

**Build-time edition vs. runtime tier** — two distinct knobs:
- **`CRUMB_EDITION`** (build-time, default `community`) decides *what compiles in*. The `community` build physically excludes the cloud-only code — the Stripe billing UI + webhook, the session-replay APIs, and the heavy `stripe` SDK and cloud AI client — so the self-host image never ships them (those routes 404). The `cloud` build includes everything. Build with `pnpm --filter dashboard build:community` (default) or `build:cloud`.
- **`CRUMB_TIER`** (runtime, default self-host) decides *behavior within the cloud edition* — per-workspace plan gating, managed creds, etc.

The cloud-only route source lives in `apps/dashboard/ee/` (**licensed under Business Source License 1.1** — see [`apps/dashboard/ee/LICENSE`](./apps/dashboard/ee/LICENSE) for details; automatically converts to AGPL-3.0 on June 21, 2030) and is overlaid into the build by `apps/dashboard/scripts/apply-ee.mjs`: `build:cloud` copies it into `app/`, `build:community` strips it. `pnpm dev` builds the cloud edition so you get every feature locally; the SDK swap relies on webpack, so a Turbopack `next dev --turbo` would behave as cloud regardless.

**Two kinds of runtime gating** (within the cloud edition — see `lib/tier.ts` + `lib/entitlements.ts`):
- **Capability-gated** — integrations and managed email unlock on *credentials present*. A self-hoster who registers their own OAuth app / SMTP relay gets them; Cloud just pre-supplies the creds.
- **Plan-gated (Cloud-only)** — AI clustering/ticket drafts and Session Record require `CRUMB_TIER=cloud` **and** a workspace plan that includes them. On Cloud, the workspace's Stripe subscription drives this: `plan_id` (`free` | `team` | `growth`) comes from the price's `lookup_key`; an active sub on **Team** unlocks AI + integrations, **Growth** adds Session Record. A BYO key does *not* unlock these on self-host — by design, they're the paid differentiators.

To run as Cloud yourself (e.g. for the hosted deployment):

```bash
CRUMB_TIER=cloud
RESEND_API_KEY=re_xxxxxxxxxxxx
CRUMB_EMAIL_FROM="Crumb <noreply@crumb.localhostlabs.net>"
CRUMB_STORAGE_PROVIDER=postgres   # share attachment + replay bytes across instances via the DB
STRIPE_SECRET_KEY=sk_live_xxx     # billing — plans drive feature entitlements
STRIPE_WEBHOOK_SECRET=whsec_xxx   # prices: set lookup_key per price to
                                  # team_monthly|team_annual|growth_monthly|growth_annual
AISTACK_API_KEY=xxx               # AI features: clustering, ticket drafts, Ask (Team plan)
# AISTACK_BASE_URL / AISTACK_MODEL  # optional — override the OpenAI-compatible endpoint / model
# Slack / Linear / Jira / GitHub OAuth-app credentials as added later
```

### Storage

Attachments (and, on Cloud, Session Record chunks) go where `CRUMB_STORAGE_PROVIDER` says:

- **`postgres`** (the Docker Compose default): the bytes live in the `storage_blobs` table, so they survive container recreates, every instance sees them, and `pg_dump` backs them up with everything else. They're stored base64-encoded, about a third larger than the file. That's fine at the 10 MB upload cap, but attachments do grow the database and its dumps. Multi-instance Cloud requires it.
- **`local`** (the default for `pnpm dev`): files under `CRUMB_STORAGE_DIR` (default `.crumb-uploads` in the dashboard's working directory). In a container that directory is inside the container, so every recreate (which every upgrade does) deletes the files. Use `local` in Docker only with `CRUMB_STORAGE_DIR` on a mounted volume, and back that directory up alongside the database.

If you run the image without the bundled compose file, set `CRUMB_STORAGE_PROVIDER=postgres` yourself; the container logs a warning on every start while files would land on its own disk. Upgrading an install that kept files on the container's disk: see DEPLOY.md "Update to a new version".

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

When a vendor replies to a thread, the customer gets an email sent as `<Workspace> via Crumb`. Without inbound wiring, it goes out from `noreply@` on your `CRUMB_EMAIL_FROM` domain. To let customers reply by email and land back on the thread:

```bash
CRUMB_INBOUND_DOMAIN=reply.yourdomain.com
CRUMB_INBOUND_SECRET=optional_shared_secret   # protects the webhook
```

The dashboard exposes `POST /api/v1/inbound/reply` accepting a generic JSON shape (`{ to, from, text, subject? }`). Point your provider's inbound parser at that endpoint (Resend Inbound, SendGrid Inbound Parse, Postmark, or a Mailgun route all work). The Reply-To on every notification is `reply+<shortId>.<token>@<CRUMB_INBOUND_DOMAIN>`, signed with the workspace's signing secret.

**Forward-to-capture.** A second inbound flow turns forwarded mail into feedback: point a parser at `POST /api/v1/inbound/email` and any message sent (or forwarded) to your capture address lands as a **pending capture** — a triable item you confirm onto an account or discard, rather than a reply on an existing thread. Same `CRUMB_INBOUND_DOMAIN` / `CRUMB_INBOUND_SECRET` wiring.

### Subscription billing (Cloud)

Crumb Cloud monetizes via Stripe. The community (self-host) edition omits billing entirely: the `/settings/billing` page and the Stripe webhook aren't compiled in (they live in `apps/dashboard/ee/`), the Billing nav item is hidden, and the `stripe` SDK is excluded from the bundle. Build the `cloud` edition (`CRUMB_EDITION=cloud`) to get them.

To wire Stripe on a Cloud deployment:

```bash
CRUMB_TIER=cloud
STRIPE_SECRET_KEY=sk_live_…       # or sk_test_… in test mode
STRIPE_WEBHOOK_SECRET=whsec_…     # from "Add endpoint" in the Stripe dashboard
# Optional:
STRIPE_PORTAL_RETURN_URL=https://crumb-app.localhostlabs.net/settings/billing
```

Create one product with **four prices** and set each price's `lookup_key` to `team_monthly`, `team_annual`, `growth_monthly`, and `growth_annual`. Checkout resolves the right price by `(plan, interval)`; the webhook maps the key's prefix (`team`/`growth`) onto `plan_id`. Enable **Stripe Tax** (`automatic_tax`) since Crumb is the merchant of record on the Stripe-direct path.

Then point a Stripe webhook endpoint at `/api/v1/stripe/webhook` and subscribe to:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

The handler keeps each workspace's `plan_id`, `subscription_status`, `seats`, `current_period_end` in sync with Stripe. New customers self-serve via **`/signup`** (Cloud-only; email-verified, creates a free workspace), then workspace admins pick a plan + interval on **`/settings/billing`** to land on a Stripe-hosted Checkout, and **Manage subscription** opens the Customer Portal for invoices, card updates, or cancellation. Identity/entitlement gates that depend on plan live behind `isActiveStatus()` in `apps/dashboard/lib/stripe.ts`.

### Rate limiting

Public-API POST endpoints (`/api/v1/items`, `/api/v1/items/[shortId]`, `/api/v1/uploads`, `/api/v1/inbound/reply`) are rate-limited per source IP using an in-memory token bucket. Defaults:

```bash
CRUMB_RATE_LIMIT_CAPACITY=60          # tokens per bucket
CRUMB_RATE_LIMIT_REFILL_PER_SEC=1     # tokens per second
```

Exhausted buckets return `429 rate_limited` with a `Retry-After` header. The limiter is process-local — fine for single-VM self-host. Cloud multi-instance swaps in a Redis-backed implementation behind the same helper.

The source IP is read from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For` hop, and the first two are trusted as sent. So keep the app reachable only through the Cloudflare Tunnel (leave `DASHBOARD_BIND` at `127.0.0.1`). Behind your own proxy instead, have it overwrite both headers with the client address (nginx: `proxy_set_header X-Real-IP $remote_addr;` and `proxy_set_header CF-Connecting-IP $remote_addr;`), or a client can claim a fresh IP on every request.

### Connecting integrations (one-click on Cloud)

Slack, Linear, Jira, and GitHub all connect through a **single central OAuth app per provider**, read
from env — there's no per-workspace app to register. So on **Crumb Cloud** (where we set those env vars
once) connecting is genuinely one-click: a workspace admin opens **Settings → Integrations**, clicks
*Connect*, approves on the provider, and lands back connected. **Self-host is BYO** — each operator
registers their own provider apps and sets the same env vars (per-provider stanzas below). Connecting
is gated to workspace admins, and on Cloud it requires the Team plan.

**Redirect URL — one knob:** every OAuth callback is `{origin}/api/integrations/<provider>/callback`.
By default the origin is inferred from the request (`x-forwarded-host`). Behind a proxy/load balancer
that's brittle, so set **`CRUMB_APP_URL`** to the dashboard's public origin (e.g.
`https://app.yourdomain.com`) — it becomes the canonical origin for all provider callbacks (precedence:
`CRUMB_APP_URL` → per-provider `*_REDIRECT_URL` → request host). Register that exact callback URL in
each provider's app. If a connect attempt can't proceed (provider not configured, plan required, not an
admin), the Connect button now shows the reason inline instead of silently doing nothing.

### Slack notifications

Workspace admins can connect Slack from **Settings → Integrations** to DM teammates when a customer replies, instead of (or, per user, in addition to) email. Each member picks their delivery channel under **Settings → Notifications**; Slack falls back to email if the lookup or DM send fails, so customer replies never go silently dropped.

Cloud comes with a Slack app registered. Self-host needs to bring its own — set:

```bash
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

Then register a Slack app at [api.slack.com/apps](https://api.slack.com/apps) with bot scopes `chat:write`, `im:write`, `users:read`, `users:read.email`, `app_mentions:read` and redirect URL `{dashboard origin}/api/integrations/slack/callback`. `SLACK_SIGNING_SECRET` (from the app's Basic Information) verifies the request signature on the `/crumb` command and the events endpoint. Optional: `SLACK_REDIRECT_URL` if the dashboard sits behind a proxy that mangles `x-forwarded-host`; `CRUMB_OAUTH_STATE_SECRET` if you want a dedicated HMAC key for the OAuth `state` of every provider (otherwise it falls back to `CRUMB_INBOUND_SECRET`, then the first provider client secret that's set).

Slack user lookups are by email — each workspace member is matched once to their Slack `user_id` and cached on first DM. Failed lookups (member's Slack email doesn't match their Crumb email) are retried after 24h.

**Request sizing (@mention).** On Cloud (Team plan), Crumb sizes incoming requests right in Slack. @mention the bot on any message in a channel it belongs to and it replies in-thread with the request restated, the requester's account and its ARR, similar open requests and their combined ARR at stake, and a rough T-shirt scope (S/M/L/XL) grounded in your connected GitHub repo's README + file tree, with a confidence level. It reads only (nothing is written to the inbox) and degrades gracefully: no account match, no repo, or AI unavailable each produce a plain note rather than a wrong answer. Because the reply shows ARR and other accounts' requests, it answers only your teammates: the person mentioning it must be in the Slack workspace that installed Crumb and have the same email as a member of your Crumb workspace (anyone else gets a one-line refusal). The requester's account comes from the mentioner's email when it belongs to an account contact. A teammate's usually doesn't, so Crumb then matches the account the message names ("Acme wants SSO"). In a Slack Connect channel shared with another organization, every reply is visible only to the person who mentioned the bot. To enable it, add the `app_mentions:read` bot scope, then turn on **Event Subscriptions** with the Request URL `{dashboard origin}/api/integrations/slack/events` (the endpoint answers Slack's one-time challenge on save) and subscribe to the `app_mention` bot event. Because it adds a scope, workspaces connected before this shipped must re-connect from **Settings → Integrations** to grant it. Self-host builds answer the webhook but post a "needs Cloud AI" note; the sizing itself is Cloud-only.

**Microsoft Teams.** Teams uses an incoming-webhook URL rather than OAuth: paste a channel's webhook under **Settings → Integrations** and Crumb posts the same close-the-loop events as Adaptive Cards. The `Test` button sends a sample card so you can confirm the wiring before going live.

### Engineering integrations

Push Crumb items out as **Linear / Jira / GitHub** tickets from the thread sidebar. Status syncs back via webhook (one-way, provider is canonical for engineering status; Crumb is canonical for the vendor↔customer relationship). On Cloud with `AISTACK_API_KEY` set, the modal also offers **Suggest with AI** — drafts a title + body matched to your team's voice using up to 10 recent ticket titles from the target, plus (if a GitHub repo is connected on the workspace) the repo's README + top-level tree as project context for any provider's draft.

Cloud comes with all three apps registered. Self-host BYO. See `apps/dashboard/.env.local.example` for the full env stanzas; the short version:

- **Linear**: register an OAuth app at `linear.app/settings/api` → `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` (+ optional `LINEAR_WEBHOOK_SECRET`). Redirect URL: `{dashboard origin}/api/integrations/linear/callback`.
- **Jira**: register a 3LO app at `developer.atlassian.com` with scopes `read:jira-work write:jira-work read:jira-user offline_access` → `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` (+ `JIRA_WEBHOOK_SECRET`). Atlassian's per-tenant `cloud_id` is discovered automatically + re-checked on every token refresh so reinstalls against a different site don't silently 404. **Cloud** also needs the `manage:jira-webhook` scope on the app (add it before deploying, or Jira connect fails at consent): each connection registers its own status webhook, kept alive by the maintenance cron, and the shared `JIRA_WEBHOOK_SECRET` webhook is refused there. Jira connections made before that must reconnect once to keep status sync. Self-host keeps the manual webhook below.
- **GitHub**: register a GitHub App (not an OAuth App) at `github.com/settings/apps` with permissions `Issues:rw + Contents:r + Metadata:r` and the `Issues` event → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (PEM), plus `GITHUB_WEBHOOK_SECRET`. Installation tokens are minted per-call from the App's JWT and cached in module memory for 50 minutes. Also set `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` (the App's client ID and a client secret) and turn on **Request user authorization (OAuth) during installation**: Crumb then checks that the person finishing the install can access that installation. Without them it only accepts an installation created or updated in the last 10 minutes, so reconnecting an older one means reinstalling the App on GitHub.

Webhook URLs (configure inside each provider's app settings):

```
{dashboard origin}/api/integrations/linear/webhook
{dashboard origin}/api/integrations/jira/webhook
{dashboard origin}/api/integrations/github/webhook
```

What this **does not** do: write Crumb status changes back to the provider, mirror comments/attachments, support multi-tracker links per item, or read deep repo code (README + tree only). See the phase plan for the deferred list.

### CRM sync — accounts & ARR

Crumb prioritizes by the revenue behind a request, so every account carries an ARR value. Connect **HubSpot** or **Salesforce** under **Settings → Integrations** and Crumb pulls your companies/accounts and their ARR, then matches incoming feedback to the right account. Like the engineering integrations it's one-click on Cloud (Team plan) and BYO OAuth on self-host:

- **HubSpot**: `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` (+ optional `HUBSPOT_ARR_PROPERTY` to preset the ARR property on self-host). Redirect URL `{dashboard origin}/api/integrations/hubspot/callback`.
- **Salesforce**: `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` (+ `SALESFORCE_LOGIN_URL` for a sandbox / My Domain). Redirect URL `{dashboard origin}/api/integrations/salesforce/callback`.

After connecting, an admin picks the CRM field that holds ARR (any number or currency field) on the integration's card. Nothing is assumed: the stock annual-revenue field is the customer company's own revenue, not what it pays you, so until a field is picked only account names sync. Line up fields under **Settings → Account mapping**. Connect-time sync and the **Sync now** button work immediately; to keep ARR fresh, hit `POST /api/v1/internal/crm-sync` on a schedule (header `X-Crumb-Sweep-Secret`, e.g. every 6h). ARR you set by hand is marked manual and is never overwritten by a sync.

### AI initiative clustering

Once a workspace has at least one Initiative, Crumb Cloud can auto-suggest which Initiative new feedback belongs to. Vendors review the guess inline — one click accepts, one click dismisses. Cloud-only; self-host stays untouched.

```bash
CRUMB_TIER=cloud
AISTACK_API_KEY=xxxxxxxxxxxxxxxxxxxx
```

Behaviour:
- **On every new item**: `POST /api/v1/items` fires a background classification against the workspace's non-parked initiatives. If the model picks one with confidence > 0.55, a pending suggestion is stored. The customer never waits — the API responds before the LLM call.
- **Inbox**: items with a pending suggestion show an `✨ User Management ✓ ✗` chip in the Initiative column. Hover shows the model's one-line reason + confidence.
- **Thread sidebar**: under the Initiative card, an "AI suggests" panel appears when nothing's set yet — same accept/dismiss controls.
- **Bulk**: select unclassified items in the inbox and click **Cluster selected** to batch-classify (capped at 25 per click to keep costs bounded).

Runs on **aistack** — an OpenAI-compatible endpoint serving an open-weight model (`qwen-35b-8bit` by default); point `AISTACK_BASE_URL` / `AISTACK_MODEL` at your own inference host to use a different one. Accepted/dismissed history is kept so a later model rerun can supersede an earlier dismissal.

### Ask your feedback

Ask a plain-English question across your feedback and get an answer grounded in the actual items — not a guess. The question is embedded, matched against the feedback corpus by vector similarity (pgvector), and an answer is composed from the top matches with inline `[FB-N]` citations that resolve back to the source items. Questions about product usage route to your usage data instead. Cloud-only (Team plan); needs `AISTACK_API_KEY` and the pgvector-enabled Postgres image (`pgvector/pgvector:pg16`).

### Insights — usage analytics & churn signals

**Insights** (`/insights` in the sidebar) turns the raw stream into a read on the relationship: median loop time (submission → outcome), open loops and the ARR behind them, first-response time, volume by status, a 12-week trend, and volume by account ARR tier. Stream product usage in via `POST /api/v1/usage-events` (`crumb.track()` from the widget) and accounts that go quiet or trend negative surface as **at-risk** churn signals. Export a per-account, QBR-style CSV with the page's **Export** button (`/insights/export`, signed-in session). The non-AI metrics run on self-host; the AI-enriched churn/sentiment signals need a Cloud Team plan.

### Session record (Cloud)

When a customer drops feedback through the widget, Crumb Cloud can attach a video-like replay of the last few minutes of their session — so the vendor sees what they were actually doing, not just what they wrote. Built on [rrweb](https://github.com/rrweb-io/rrweb) (MIT). Cloud-only.

Enable per-workspace at **Settings → Integrations → Session record**. When on, the widget injects a second small bundle (`/widget-record.js`) after `/me` resolves; the launcher itself stays lean. Captured chunks flush every ~5s via `fetch`, with a `sendBeacon` final-flush on `pagehide`.

What a replay contains, exactly:
- Nothing until the customer ticks **Record my session** in the widget (remembered for that tab; unticking stops it).
- The page's DOM as rendered (snapshot and changes), mouse movement, clicks, scrolling, the page URL (secret-looking query and fragment values redacted, as for requests below), browser user agent, and viewport and screen size.
- For each `fetch` / XHR request the page makes: method, URL, status and timing. Query-string values whose names look secret (`password`, `token`, `secret`, `auth`, `…key`, `session`, `signature`, `code` and similar) are replaced with `[redacted]`, and `user:pass@` credentials are dropped. Headers and cookies are never recorded, and Crumb's own API calls aren't captured.
- **No request or response bodies.** A host can opt in per embed with `data-record-network-bodies="true"` on the widget `<script>` tag. Bodies are then kept (truncated to 2 KB), with secret-looking keys still redacted in form-encoded, query-string and JSON bodies, and the widget's consent text says so.
- Values typed into `<input>`, `<textarea>` and `<select>` fields are masked, password and email fields included. Text in rich-text editors (`contenteditable`) and hidden-input values are page markup and record as-is; add `class="crumb-mask"` (text) or `class="crumb-block"` (whole element) to keep them out.
- The Crumb widget itself is blocked from recording (no recursive UI).
- Vendors can opt out customer-side via `class="crumb-block"` (skip whole subtree) or `class="crumb-mask"` (mask text).

Cost guard-rails (capped per session):
- 10 MB of events
- 5,000 events
- 30 minutes

The recorder stops itself client-side at each cap; the server returns 413 if exceeded. Sessions are linked to a feedback item only after the customer submits with ≥1 chunk flushed. Empty sessions stay orphan and can be swept later. **Replays are deleted after 30 days by default**, enforced by the cleanup sweep below. Set `CRUMB_REPLAY_RETENTION_DAYS` (with `_FREE` / `_TEAM` / `_GROWTH` overrides, which win) to change the window; `0` keeps replays forever.

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
        data-workspace="southbeam"
        data-user-email="user@theircompany.com"
        data-user-name="User Name"
        data-account-name="Their Company"
        defer></script>
```

(For trusted identity, pass a signed `data-user-jwt` instead of the plain `data-*` attributes; the API then trusts only the JWT's claims. **On Cloud the signed JWT is required** — the API rejects plain `data-*` identity with `401 jwt_required`; self-host still accepts plain attributes as a fallback.)

In a single-page app, drive identity from JavaScript: `crumb.identify({ jwt })` after sign-in, `crumb.shutdown()` on sign-out, and `crumb.onTokenExpired(cb)` to hand the widget a fresh token when one expires. `data-app-version` (or `crumb.setContext({ app_version })`) sends your build with each new request, and `data-locale` sets the widget's language. **Settings → Install** has copy-paste snippets for these and for `crumb.open()` and `crumb.onUnread()`.

### Public API

| Method | Path                                  | What it does                                     |
| ------ | ------------------------------------- | ------------------------------------------------ |
| `POST` | `/api/v1/items`                       | Create an item; auto-creates account + user      |
| `GET`  | `/api/v1/items?workspace&email`       | List the calling customer's submissions          |
| `GET`  | `/api/v1/items/[shortId]?workspace&email` | Read a thread (only if the caller submitted it) |
| `POST` | `/api/v1/items/[shortId]`             | Customer reply on a thread                       |
| `GET`  | `/api/v1/roadmap?workspace&email`     | Public roadmap items, grouped Now / Next / Later |
| `GET`  | `/api/v1/me?workspace&email`          | The calling customer's identity + workspace meta |
| `POST` | `/api/v1/uploads`                     | Upload an attachment                             |

All endpoints CORS-enabled (`Access-Control-Allow-Origin: *`) until auth narrows it down per-workspace.

The full reference (customer API, MCP server, outgoing webhooks and operator endpoints, with request and response shapes) is in [docs/API.md](docs/API.md).

**MCP server.** AI assistants (Claude Desktop, Cursor, any MCP client) can read and triage your feedback over the Model Context Protocol at `{dashboard origin}/api/mcp`. Create a key under **Settings → API keys** and send it as `Authorization: Bearer <key>`; the key acts as the teammate who created it. Tools and limits: [docs/API.md](docs/API.md#mcp-server).

### Try the create endpoint directly

The embedded widget will POST to `/api/v1/items`. You can hit it manually right now:

```bash
curl -X POST http://localhost:3000/api/v1/items \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_slug": "southbeam",
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
| `pnpm db:migrate`  | Apply SQL migrations (needs `DATABASE_URL`)       |
| `pnpm db:generate` | Write a migration after editing the schema        |
| `pnpm db:seed`     | Reseed sample data (wipes existing rows first)    |
| `pnpm db:studio`   | Open Drizzle Studio against the local DB          |
| `pnpm widget:build`| Build the embed widget bundle                     |
| `pnpm widget:dev`  | Rebuild the widget on save (esbuild watch)        |

## Self-host

The whole stack — Postgres + the dashboard + the widget bundle it serves — runs from one compose file. From a fresh checkout:

```bash
docker compose up -d --build
```

This builds the dashboard image, brings Postgres up, waits for it to be healthy, then starts the dashboard. The container runs SQL migrations on each startup before booting the server.

**First run.** Sign-in is invite-only, so the first admin comes from a one-time setup link:

1. While the database has no workspace, the dashboard prints a setup link to its logs on every start, in a box headed "Crumb first run". Read it with `docker compose logs dashboard`.
2. Open the link and create your workspace and admin account. You're signed in when you finish. The link works once and expires after 60 minutes. For a fresh one, run `docker compose exec dashboard node packages/db/dist/cli.mjs setup-link`.
3. Invite teammates from **Settings → Team**.

The link is built from `CRUMB_APP_URL`. When that's unset (as on a local run without a `.env`) you get only the `/onboard?token=…` path, so open it on your dashboard's address, e.g. `http://localhost:3000/onboard?token=…`. Once a workspace exists, nothing more is printed and `/onboard` without a link sends visitors to sign in.

Configure it with a `.env` file next to `docker-compose.yml` (start from `.env.example`). Compose passes every variable in it to the dashboard container, so any setting documented in `apps/dashboard/.env.local.example` works there. Your shell environment only fills in the compose file's own `${...}` values (ports, the build arg and the defaults below); it doesn't otherwise reach the container. Compose-level defaults:

| Var                    | Default        | What it does                                                |
| ---------------------- | -------------- | ----------------------------------------------------------- |
| `POSTGRES_USER`        | `crumb`        | Postgres role                                               |
| `POSTGRES_PASSWORD`    | `crumb`        | Postgres password                                           |
| `POSTGRES_DB`          | `crumb`        | Postgres database name                                      |
| `POSTGRES_PORT`        | `5432`         | Host port for Postgres                                      |
| `DASHBOARD_PORT`       | `3000`         | Host port for the dashboard                                 |
| `CRUMB_TIER`           | `self_host`    | Runtime tier (`cloud` only for the hosted product)          |
| `CRUMB_STORAGE_PROVIDER` | `postgres`   | Where attachments live; see [Storage](#storage)             |
| `CRUMB_SKIP_MIGRATIONS`| _(unset)_      | Set to `1` to skip the migrate step on container startup    |
| `CRUMB_EDITION`        | `community`    | **Build arg** (not runtime): `community` self-host build or `cloud`. See [Self-host vs. Crumb Cloud](#self-host-vs-crumb-cloud) |

`CRUMB_EDITION` is consumed at `--build` time (passed through to the Dockerfile by `docker-compose.yml`), so changing it requires a rebuild: `CRUMB_EDITION=cloud docker compose up -d --build`. The default community build omits the Stripe-billing and session-replay routes and their SDKs.

To seed sample data into a fresh self-hosted deploy:

```bash
docker compose exec dashboard sh -c "node packages/db/dist/migrate.mjs && true"   # already ran via entrypoint
# Then from your host (need pnpm available):
DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb pnpm db:seed
```

To use your own managed Postgres (it needs the `vector` extension), replace `DATABASE_URL` under the dashboard service in `docker-compose.yml`, which otherwise derives it from the `POSTGRES_*` values, and remove the `postgres` service and the dashboard's `depends_on`. A `DATABASE_URL` in `.env` doesn't override it.

The hosted tier is live at [crumb-app.localhostlabs.net](https://crumb-app.localhostlabs.net), running the same code with auth, billing, and the AI features layered on top.

### Health checks

Two probes for load balancers / orchestrators:

- `GET /api/health` — **liveness**: always `200 {ok:true}` while the process is up. Restart the container if this fails.
- `GET /api/health/ready` — **readiness**: `200` only when Postgres is reachable, else `503`. Route traffic only to ready instances.

The bundled `docker-compose.yml` already wires the dashboard container healthcheck to `/api/health/ready`.

### Secrets from files

Every sensitive env var also accepts a `*_FILE` companion pointing at a file whose contents are the value — the Docker/Kubernetes secrets convention. The entrypoint loads `FOO` from `FOO_FILE` at startup (for both the migrate step and the server) unless `FOO` is already set directly. Example with Docker secrets:

```yaml
services:
  dashboard:
    environment:
      DATABASE_URL: ""   # the stock compose file sets this, and a set variable wins over its _FILE
      DATABASE_URL_FILE: /run/secrets/db_url
      CRUMB_ENCRYPTION_KEY_FILE: /run/secrets/enc_key
      STRIPE_SECRET_KEY_FILE: /run/secrets/stripe_key
    secrets: [db_url, enc_key, stripe_key]
secrets:
  db_url:    { file: ./secrets/db_url }
  enc_key:   { file: ./secrets/enc_key }
  stripe_key:{ file: ./secrets/stripe_key }
```

For production, set `CRUMB_ENCRYPTION_KEY` (`openssl rand -hex 32`) so integration tokens are encrypted at rest. Set it after integrations were connected? `docker compose exec dashboard node packages/db/dist/backfill-encrypt-secrets.mjs` encrypts the Slack, Linear and Jira tokens already stored. `apps/dashboard/.env.local.example` documents every variable, key rotation included.

### Backups & restore

With the compose default `CRUMB_STORAGE_PROVIDER=postgres`, Crumb keeps everything in Postgres, attachment and replay bytes included, so a single `pg_dump` is a full backup. If you switched to `local` storage, also copy `CRUMB_STORAGE_DIR`.

```bash
# Back up (compressed custom format)
docker compose exec -T postgres pg_dump -U crumb -Fc crumb > crumb-$(date +%F).dump

# Restore into a fresh DB
docker compose exec -T postgres pg_restore -U crumb -d crumb --clean --if-exists < crumb-2026-01-01.dump
```

Schedule the dump however you like (host cron, a sidecar) and ship the file off-box. Migrations are forward-only and run on startup; restoring a dump from an older release, then deploying the newer image, applies any pending migrations automatically.

### Maintenance cron

Three internal endpoints do scheduled work. Set `CRUMB_INTERNAL_SWEEP_SECRET`, then `POST` to each with the header `X-Crumb-Sweep-Secret: <secret>` (they return 503 until the secret is set):

- `/api/v1/internal/replay-sweep`, hourly: prunes orphaned uploads and replay sessions, enforces replay retention, drops aged usage events (a bounded batch per run).
- `/api/v1/internal/crm-sync`, every few hours: refreshes accounts and ARR from a connected CRM.
- `/api/v1/internal/feedback-sync`, every 15 to 30 minutes: pulls new tickets and calls from connected feedback sources.

```bash
curl -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" \
  http://localhost:3000/api/v1/internal/replay-sweep
```

DEPLOY.md has crontab lines that read the secret from `.env`.

## License

AGPL-3.0. If you offer Crumb as a service to others, the source of your fork has to stay open. Self-hosting for your own company is fully permitted.
