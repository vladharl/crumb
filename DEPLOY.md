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
docker version && docker compose version          # sanity check
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
- `CRUMB_APP_URL=https://crumb.localhostlabs.net`
- `CRUMB_ENCRYPTION_KEY` → `openssl rand -hex 32` (encrypts integration tokens)
- `CRUMB_INTERNAL_SWEEP_SECRET` → `openssl rand -hex 32`
- `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` (and any other integrations you've registered)
- *(optional)* CRM sync — `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET` and/or `SALESFORCE_CLIENT_ID`/`SALESFORCE_CLIENT_SECRET` to pull accounts + ARR. Redirect URLs: `…/api/integrations/hubspot/callback` and `…/api/integrations/salesforce/callback`.
- `CLOUDFLARE_TUNNEL_TOKEN` → from step 5

`.env` is gitignored — never commit it.

## 5. Create the Cloudflare Tunnel  **(you, browser)**
1. **Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel** → type **Cloudflared** → name it `crumb` → **Save**.
2. On the install screen, **copy the tunnel token** (the long string after `--token` in the shown command). Put it in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=...`. *(You don't run their install command — our compose runs cloudflared with this token.)*
3. Open the tunnel → **Public Hostname → Add a public hostname**:
   - **Subdomain:** `crumb`  · **Domain:** `localhostlabs.net`
   - **Service:** **HTTP** → `dashboard:3000`
   - Save. Cloudflare creates the `crumb` DNS record for you automatically.

## 6. Launch
```bash
docker compose --profile tunnel up -d --build
```
- `--build` compiles the community image (a few minutes on first run).
- The `tunnel` profile starts cloudflared alongside dashboard + Postgres.
- Migrations run automatically on dashboard startup.

Check it's healthy:
```bash
docker compose ps                         # all "healthy"/"running"
docker compose logs -f dashboard          # watch boot + migrations
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health/ready
```
Then open **https://crumb.localhostlabs.net** in your browser.

## 7. First login
Auth is magic-link email. If you haven't configured email (`CRUMB_EMAIL_PROVIDER`
unset), the link **prints to the logs** — grab it there:
```bash
docker compose logs dashboard | grep -i "magic\|login\|http"
```
For real email, set `CRUMB_EMAIL_PROVIDER=smtp` + `SMTP_*` (or Resend on cloud tier) and `docker compose up -d` again.

## 8. Connect Slack (and others)
In the app → **Settings → Integrations → Connect Slack**. Confirm the Slack app's
redirect URL is exactly `https://crumb.localhostlabs.net/api/integrations/slack/callback`
(it must match `CRUMB_APP_URL`). Repeat per provider you registered.

---

## Operations

**Update to a new version:**
```bash
git pull && docker compose --profile tunnel up -d --build
```

**Maintenance cron** (orphan attachment/replay sweep + usage-event retention) — add to the VPS crontab:
```bash
# daily at 03:00
0 3 * * * curl -fsS -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" http://127.0.0.1:3000/api/v1/internal/replay-sweep
```
The same endpoint prunes `usage_events` older than `CRUMB_USAGE_EVENTS_RETENTION_DAYS` (default 180). If you instrument `crumb.track()` heavily, run this daily so the high-cardinality `usage_events` table stays bounded.

**CRM refresh cron** (optional, only if you connected HubSpot/Salesforce) — keeps accounts + ARR fresh. The "Sync now" button and connect-time sync work without it:
```bash
# every 6 hours
0 */6 * * * curl -fsS -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" http://127.0.0.1:3000/api/v1/internal/crm-sync
```

**Backups** (Postgres): `docker compose exec postgres pg_dump -U crumb crumb | gzip > crumb-$(date +%F).sql.gz` (see README "Backups & restore").

**pgvector upgrade note:** the Postgres image is `pgvector/pgvector:pg16` (needed for the embeddings / semantic-search features — the migration runs `CREATE EXTENSION vector`). It's a drop-in replacement for the stock `postgres:16` and reuses the same `crumb-pg-data` volume, but **take a backup before the first `up -d` that pulls it** (command above). If you run an **external/managed Postgres** instead of the bundled container, install the extension once as a superuser: `CREATE EXTENSION IF NOT EXISTS vector;` (most managed providers — RDS, Cloud SQL, Supabase — ship it).

**Firewall:** with the tunnel, you can keep inbound 80/443 **closed** — cloudflared only needs outbound. Allow SSH only.

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
| Public URL | `https://crumb.localhostlabs.net` |
| Tunnel service target | `http://dashboard:3000` |
| Slack redirect URL | `https://crumb.localhostlabs.net/api/integrations/slack/callback` |
| Start (with tunnel) | `docker compose --profile tunnel up -d --build` |
| Logs | `docker compose logs -f dashboard` |
| Health | `http://127.0.0.1:3000/api/health/ready` (on the box) |
