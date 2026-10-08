# Hosted integration verification suite

Automated Playwright checks that every integration is **wired correctly on a
live, already-running Crumb deployment** — run with **safe (non-destructive)
operations only**. Unlike `tests/e2e/`, this suite never re-seeds the DB, never
boots a server, and never mutates real workspace data.

```
cd apps/dashboard
CRUMB_E2E_SESSION=… CRUMB_E2E_API_KEY=… pnpm test:e2e:hosted
```

## What it checks

| Spec | Integration(s) | Safe assertions |
|---|---|---|
| `health.spec.ts` | platform | `/api/health` + `/api/health/ready` → 200 |
| `oauth-init.spec.ts` | Slack, Linear, Jira, GitHub, HubSpot, Salesforce | Connect → correct authorize URL (host, `redirect_uri = CRUMB_APP_URL + /api/integrations/<p>/callback`, `client_id`, scopes, signed `state`) **without completing the flow**; or the "Not set up" card whose self-host setup details name the env vars |
| `integration-callbacks.spec.ts` | the 6 above + customer webhooks | OAuth callbacks with no params → `?<p>=error_*` redirect; Linear/Jira/GitHub webhooks → 400 on bad signature; customer integrations webhook → 401 on malformed bearer |
| `settings-pages.spec.ts` | all UI cards | integrations / api-keys / webhooks pages render; session-record shows the Cloud-gating copy on self-host |
| `mcp.spec.ts` | MCP server + API keys | no bearer → 401; `initialize`; `tools/list` registry; **read-only** tool calls |
| `inbound-email.spec.ts` | reply-by-email + forward-to-capture | endpoints reject bad auth / unsigned address before any insert |
| `cloud-gating.spec.ts` | Stripe, AI, session-replay, sweep | cloud-only routes 404 on community (4xx on cloud); sweep → 401/503 (real secret never sent) |

Mutating happy-paths (OAuth token exchange, real webhook/Teams delivery, inbound
item creation, status changes, real sweeps) are **deliberately not run here** —
they live in the seeded local suite (`tests/e2e/`).

## Credentials (provision once)

| Env | Enables | How to get it |
|---|---|---|
| `CRUMB_E2E_SESSION` | UI specs (settings pages, OAuth init) | Log into the host as an admin, copy the `crumb_session` cookie value from devtools |
| `CRUMB_E2E_API_KEY` | MCP specs | `/settings/api-keys` on the host → create a key (`crumb_sk_…`) |

Specs that lack their credential **skip** (not fail), so a partial set still runs
the unauthenticated health / callback / cloud-gating / inbound checks.

### Optional env

| Env | Default | Purpose |
|---|---|---|
| `CRUMB_E2E_HOSTED_URL` | `https://crumb-app.localhostlabs.net` | target deployment |
| `CRUMB_E2E_EXPECTED_APP_URL` | = base URL | expected `CRUMB_APP_URL` in `redirect_uri` asserts |
| `CRUMB_E2E_EDITION` | `community` | `cloud` flips the cloud-gating expectations |

### Optional SSH session bootstrap

Instead of `CRUMB_E2E_SESSION`, set `CRUMB_E2E_SSH_BOOTSTRAP=1` (and optionally
`CRUMB_E2E_ADMIN_EMAIL`) to have global setup mint **one additive, 7-day**
`sessions` row on the host via `docker exec psql` over SSH
(`CRUMB_E2E_SSH_HOST`, default `eissa-vps`; `CRUMB_E2E_PG_CONTAINER/USER/DB`).
Additive + auto-expiring, so still safe ops. Falls back to "no session" on any
failure.

## CI

`.github/workflows/e2e-hosted.yml` runs this on `workflow_dispatch` (and an
optional nightly schedule) with credentials from repo secrets. It is **not** on
the per-PR path — it hits a live host.

## Limitations

We verify **wiring**, not full happy-paths: authorize URLs, callbacks mounted &
fail-closed, endpoints enforcing auth, and correct tier/edition gating. We do not
complete real OAuth grants, deliver real Teams/webhook messages, create inbound
items, or run Stripe checkout / sweeps. The SSH-bootstrap fallback assumes the
host's Postgres container name and admin role; otherwise use `CRUMB_E2E_SESSION`.
