# Deploying Crumb to a Hostinger VPS (with Cloudflare Tunnel)

This runs the whole stack — dashboard + Postgres + a Cloudflare Tunnel — on one
small VPS, served at your domain with **no open inbound ports**. Sized for a
single client; a Hostinger **KVM 1** (1 vCPU / 4 GB / ~50 GB) is plenty.

> Crumb is a Node.js server app (Postgres over TCP, SMTP, `node:crypto`). It must
> run on a VPS/container host — **not** Hostinger shared/web hosting and **not**
> Cloudflare Pages/Workers.

Steps marked **(you)** need your browser/credentials and can't be automated.

---

## 1. Provision the VPS  **(you)**
- Hostinger → **VPS** (KVM) → pick **Ubuntu 24.04** (or 22.04). KVM 1 is enough.
- Note the server's IP and your SSH login.

## 2. Install Docker  **(you, on the VPS)**
SSH in, then (skip if you chose a Docker/Coolify template that already has it):
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker   # run docker without sudo
docker version && docker compose version          # sanity check: Compose 2.24 or newer
```

## 3. Get the code
```bash
git clone <your-crumb-repo-url> crumb && cd crumb
```
*(Alternative, to skip building on the box: pull the prebuilt community image from
GHCR — see "Build elsewhere" at the bottom.)*

## 4. Configure environment
```bash
cp .env.example .env
nano .env
```
Fill in at minimum:
- `POSTGRES_PASSWORD` → a long random string (`openssl rand -hex 24`)
- `CRUMB_APP_URL` → your dashboard's public URL, e.g. `https://crumb.example.com`
- `CRUMB_ENCRYPTION_KEY` → `openssl rand -hex 32` (encrypts integration tokens)
- `CRUMB_INTERNAL_SWEEP_SECRET` → `openssl rand -hex 32`
- `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` (and any other integrations you've registered). `SLACK_SIGNING_SECRET` verifies Slack request signatures on the `/crumb` command and the events endpoint.
- *(optional)* CRM sync — `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET` and/or `SALESFORCE_CLIENT_ID`/`SALESFORCE_CLIENT_SECRET` to pull accounts + ARR. Redirect URLs: `…/api/integrations/hubspot/callback` and `…/api/integrations/salesforce/callback`.
- *(GitHub App)* also `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET`, with **Request user authorization (OAuth) during installation** turned on in the App. Without them Crumb only accepts an installation made in the last 10 minutes, so reconnecting an older one means reinstalling the App.
- `CLOUDFLARE_TUNNEL_TOKEN` → from step 5

`.env` is gitignored: never commit it. Compose passes every variable in it to
the dashboard, so any optional setting from `apps/dashboard/.env.local.example`
(rate limits, logging, AI caps, key rotation, and so on) works by adding it here.

## 5. Create the Cloudflare Tunnel  **(you, browser)**
1. **Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel** → type **Cloudflared** → name it `crumb` → **Save**.
2. On the install screen, **copy the tunnel token** (the long string after `--token` in the shown command). Put it in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=...`. *(You don't run their install command — our compose runs cloudflared with this token.)*
3. Open the tunnel → **Public Hostname → Add a public hostname**:
   - **Subdomain:** `crumb`  · **Domain:** your domain (e.g. `example.com`)
   - **Service:** **HTTP** → `dashboard:3000`
   - Save. Cloudflare creates the `crumb` DNS record for you automatically.

## 6. Launch
```bash
docker compose --profile tunnel up -d --build
```
- `--build` compiles the community image (a few minutes on first run).
- The `tunnel` profile starts cloudflared alongside dashboard + Postgres.
- Migrations run automatically on dashboard startup.
- While the database has no workspace, startup also prints a one-time setup link (step 7).

Check it's healthy:
```bash
docker compose ps                         # all "healthy"/"running"
docker compose logs -f dashboard          # watch boot + migrations
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health/ready
```
Then create your workspace (step 7).

## 7. Create your workspace and sign in
Sign-in is invite-only, so the first admin comes from a one-time setup link. While
the database has no workspace, the dashboard prints one to its logs on every start,
in a box headed "Crumb first run":
```bash
docker compose logs dashboard
```
Open the link, then create your workspace and admin account. You're signed in when
you finish. The link works once and expires after 60 minutes. For a fresh one:
```bash
docker compose exec dashboard node packages/db/dist/cli.mjs setup-link
```
The link is built from `CRUMB_APP_URL` (step 4). If that's unset you get only the
`/onboard?token=…` path, to open on your domain. Once a workspace exists, nothing
more is printed and `/onboard` without a link sends visitors to sign in.

After that, auth is magic-link email. If you haven't configured email
(`CRUMB_EMAIL_PROVIDER` unset), sign-in and invite emails **print to the logs**:
```bash
docker compose logs dashboard | grep -i "magic\|login\|http"
```
For real email, set `CRUMB_EMAIL_PROVIDER=smtp` + `SMTP_*` (or Resend on cloud tier) and `docker compose up -d` again.

## 8. Connect Slack (and others)
In the app → **Settings → Integrations → Connect Slack**. Confirm the Slack app's
redirect URL is exactly `https://crumb.example.com/api/integrations/slack/callback`
(it must match `CRUMB_APP_URL`). Repeat per provider you registered.

**Jira on Cloud (`CRUMB_TIER=cloud`).** Add the `manage:jira-webhook` scope to the
Atlassian app **before** deploying, or Jira connect fails at consent. Each Jira
connection then registers its own status webhook (the maintenance cron keeps it
alive), and the shared `JIRA_WEBHOOK_SECRET` webhook is refused. Jira connections
made before this must reconnect once from Settings → Integrations to keep status
sync. Self-host is unchanged: the manual webhook signed with `JIRA_WEBHOOK_SECRET`.

**Enable @mention request sizing.** To let people @mention Crumb for an in-thread
sizing reply, the Slack app needs the `app_mentions:read` bot scope and Event
Subscriptions turned on: set the **Request URL** to
`https://crumb.example.com/api/integrations/slack/events` (Slack sends a
one-time `challenge` on save and the endpoint answers it), then subscribe to the
`app_mention` bot event. `SLACK_SIGNING_SECRET` must be set (it verifies the
request signature). Workspaces connected before this scope existed must
re-connect from Settings → Integrations to grant it. Sizing is Cloud + AI-gated;
self-host answers the webhook but posts a "needs Cloud AI" note.

---

## Operations

**Update to a new version:**
```bash
git pull && docker compose --profile tunnel up -d --build
```
*Once, if your install predates Postgres file storage* (uploads were kept on the
container's disk, which `up -d` throws away): copy the files out **before** that
command, then load them into the database once the new version is running.
```bash
# before upgrading
docker cp crumb-dashboard:/app/apps/dashboard/.crumb-uploads ./crumb-uploads
# after upgrading
(cd crumb-uploads && find . -type f | sed 's|^\./||' | while read -r key; do
  printf "INSERT INTO storage_blobs (key, content_type, data_b64, size_bytes) VALUES ('%s', 'application/octet-stream', '%s', %s) ON CONFLICT (key) DO NOTHING;\n" \
    "$key" "$(base64 < "$key" | tr -d '\n')" "$(wc -c < "$key" | tr -d ' ')"
done) | docker compose exec -T postgres psql -U crumb -d crumb -q
```
If you already keep `local` storage on a mounted volume, set
`CRUMB_STORAGE_PROVIDER=local` in `.env` instead, before upgrading.

**Maintenance cron.** Four internal endpoints do scheduled work. Each takes a
`POST` with `CRUMB_INTERNAL_SWEEP_SECRET` in the `X-Crumb-Sweep-Secret` header,
and returns 503 until that secret is set. Cron doesn't load `.env`, so each line
reads the secret from it (adjust the path if you cloned somewhere other than
`~/crumb`, and the port if you changed `DASHBOARD_PORT`). Add them with
`crontab -e`:
```bash
# Hourly: prune orphaned uploads and replay sessions, enforce replay retention, drop aged usage events
0 * * * * curl -fsS -X POST -H "X-Crumb-Sweep-Secret: $(sed -n 's/^CRUMB_INTERNAL_SWEEP_SECRET=//p' $HOME/crumb/.env)" http://127.0.0.1:3000/api/v1/internal/replay-sweep
# Every 6 hours: refresh accounts + ARR from HubSpot / Salesforce (no-op until a CRM is connected)
0 */6 * * * curl -fsS -X POST -H "X-Crumb-Sweep-Secret: $(sed -n 's/^CRUMB_INTERNAL_SWEEP_SECRET=//p' $HOME/crumb/.env)" http://127.0.0.1:3000/api/v1/internal/crm-sync
# Every 20 minutes: pull new tickets and calls from connected feedback sources into the Inbox (no-op until one is connected)
*/20 * * * * curl -fsS -X POST -H "X-Crumb-Sweep-Secret: $(sed -n 's/^CRUMB_INTERNAL_SWEEP_SECRET=//p' $HOME/crumb/.env)" http://127.0.0.1:3000/api/v1/internal/feedback-sync
# Daily at 9:00 (server time): email each teammate's daily or weekly digest (each gets at most one per period), then embed items AI-entitled workspaces still lack (Cloud)
0 9 * * * curl -fsS -X POST -H "X-Crumb-Sweep-Secret: $(sed -n 's/^CRUMB_INTERNAL_SWEEP_SECRET=//p' $HOME/crumb/.env)" http://127.0.0.1:3000/api/v1/internal/digest
```
These lines need a plain `CRUMB_INTERNAL_SWEEP_SECRET=<value>` line in `.env`
(no quotes or trailing comment). Each replay-sweep run removes a bounded batch
(500 orphaned sessions, 500 expired replays, 500 orphaned uploads and 5,000
`usage_events` older than `CRUMB_USAGE_EVENTS_RETENTION_DAYS`, default 180), so
keep it hourly, especially if you instrument `crumb.track()` heavily. Replays
expire after `CRUMB_REPLAY_RETENTION_DAYS` (default 30, so the first runs clear
every older replay; `0` keeps them forever). On Cloud the sweep also refreshes
the Jira status webhooks. CRM sync and the feedback pull also run from their **Sync now**
buttons; on Cloud the feedback pull's AI "new & relevant" gate dedups and
auto-promotes, while on self-host every pulled record lands for review.

**Backups:** `docker compose exec -T postgres pg_dump -U crumb crumb | gzip > crumb-$(date +%F).sql.gz` (see README "Backups & restore"). With the default `CRUMB_STORAGE_PROVIDER=postgres`, uploaded files are in the database, so the dump includes them. If you switched to `local` storage, back up `CRUMB_STORAGE_DIR` as well.

**Encrypting tokens stored before you set `CRUMB_ENCRYPTION_KEY`:** `docker compose exec dashboard node packages/db/dist/backfill-encrypt-secrets.mjs` seals the Slack, Linear and Jira tokens already in the database (safe to re-run). Reconnect any other integration to encrypt its secret.

**pgvector upgrade note:** the Postgres image is `pgvector/pgvector:pg16` (needed for the embeddings / semantic-search features — the migration runs `CREATE EXTENSION vector`). It's a drop-in replacement for the stock `postgres:16` and reuses the same `crumb-pg-data` volume, but **take a backup before the first `up -d` that pulls it** (command above). If you run an **external/managed Postgres** instead of the bundled container, install the extension once as a superuser: `CREATE EXTENSION IF NOT EXISTS vector;` (most managed providers — RDS, Cloud SQL, Supabase — ship it).

**Firewall:** with the tunnel, you can keep inbound 80/443 **closed**: cloudflared only needs outbound. Allow SSH only. Keep `DASHBOARD_BIND` at `127.0.0.1` too: per-IP rate limits trust the `CF-Connecting-IP` header, which only Cloudflare should be able to set (README "Rate limiting").

**Build elsewhere (optional, for low-RAM boxes):** the repo's release workflow
publishes the community image to GHCR. Instead of building on the VPS, set the
dashboard service to `image: ghcr.io/<you>/crumb-dashboard:latest` (remove the
`build:` block) and `docker compose --profile tunnel pull && up -d`.

---

## Stripe billing (Cloud go-live)

Only applies to the **Cloud edition** (built with `CRUMB_EDITION=cloud`, run with
`CRUMB_TIER=cloud`). Self-host is free under AGPL and has no billing — skip this.
Billing collapses to "free" until every step below is done, so treat it as a
gate, not a nice-to-have.

**1. Product + 4 prices, with exact lookup keys.** In the Stripe dashboard,
create one product and four recurring prices. Set each price's **Lookup key** to
*exactly* one of these — they're the single source of truth that ties a price to
a plan + interval (`lib/stripe.ts` `lookupKeyFor` builds them; the webhook's
`planIdFromLookupKey` reads the `team`/`growth` prefix back to set the plan):

| Plan | Interval | Lookup key |
|---|---|---|
| Team | Monthly | `team_monthly` |
| Team | Annual | `team_annual` |
| Growth | Monthly | `growth_monthly` |
| Growth | Annual | `growth_annual` |

If a lookup key is missing/misspelled, checkout fails at click time with
"No Stripe price found…".

**2. Enable Stripe Tax.** We're the merchant of record (Stripe-direct), and
checkout already requests `automatic_tax` + tax-id + billing-address collection.
Turn on Stripe Tax and set your origin address so VAT/sales tax is charged.

**3. Webhook endpoint.** Add an endpoint at
`https://<your-host>/api/v1/stripe/webhook` subscribed to exactly these events
(the only four the handler processes):
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.payment_failed`.

**4. Environment.** Set on the dashboard service:
- `STRIPE_SECRET_KEY` → the **live** secret key (`sk_live_…`). A `sk_test_…` key
  on a live deployment lets checkout complete but **never charges** — the billing
  page shows a red "test mode on a live deployment" banner and checkout logs a
  warning if you do this.
- `STRIPE_WEBHOOK_SECRET` → the signing secret of the endpoint from step 3
  (without it the webhook returns 503 and subscriptions never sync).
- `STRIPE_PORTAL_RETURN_URL` *(optional)* → defaults to `…/settings/billing`.

**5. Smoke test** (Stripe **test mode** first, with a separate test key + test
webhook secret, then repeat in live):
1. As a workspace admin, **Settings → Billing → pick a plan → Upgrade**.
2. Complete checkout with test card `4242 4242 4242 4242`.
3. In Stripe → **Developers → Events**, confirm `customer.subscription.created`
   was delivered to your endpoint (200).
4. Reload billing: `Plan` shows team/growth, status `Active`, and the paid
   features appear under "Includes" + the "This month" usage meters render.
5. Failure path: in the Stripe customer, fail the next invoice (or use card
   `4000 0000 0000 0341`) → confirm the **Past due** banner appears and the
   admin dunning email is sent.

## Quick reference
| Thing | Value |
|---|---|
| Public URL | `https://crumb.example.com` (your domain) |
| Tunnel service target | `http://dashboard:3000` |
| Slack redirect URL | `https://crumb.example.com/api/integrations/slack/callback` |
| Slack Events URL | `https://crumb.example.com/api/integrations/slack/events` |
| Start (with tunnel) | `docker compose --profile tunnel up -d --build` |
| Logs | `docker compose logs -f dashboard` |
| Health | `http://127.0.0.1:3000/api/health/ready` (on the box) |
