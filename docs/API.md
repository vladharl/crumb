# Crumb API reference

Crumb has three integration surfaces:

| Surface | Path | Who calls it | Credential |
| --- | --- | --- | --- |
| [Customer API](#customer-api) | `/api/v1/…` | The embedded widget, or your own UI and backend acting for one signed-in customer | Customer identity token (a JWT your server signs) |
| [MCP server](#mcp-server) | `/api/mcp` | AI assistants (Claude, Cursor, any MCP client) working on your team's behalf | Workspace API key (`crumb_sk_…`) |
| [Webhooks](#webhooks) | your URL | Crumb, when something happens in your workspace | HMAC signature you verify |

A few [operator endpoints](#operator-endpoints) (inbound email, cron jobs, health checks) round it out.

**Base URL.** Every path below is relative to your Crumb origin: `https://crumb-app.localhostlabs.net` on Crumb Cloud, or whatever `CRUMB_APP_URL` is on a self-hosted install.

**Editions.** Self-host and Cloud run the same API with three differences, called out where they apply: Cloud requires a signed identity token on the customer API, session replay endpoints exist only on Cloud, and on Cloud webhook targets must resolve to public addresses.

Contents:

- [Authentication](#authentication)
- [Conventions](#conventions): errors, rate limits, CORS
- [Customer API](#customer-api)
- [MCP server](#mcp-server)
- [Webhooks](#webhooks)
- [Operator endpoints](#operator-endpoints)

---

## Authentication

### Customer identity token (customer API)

Your server signs a short-lived JWT for the customer who is signed in to your product, and the widget (or your code) sends it on every call:

```
Authorization: Bearer <jwt>
```

Crumb trusts the claims in the token, never values sent alongside it.

- **Algorithm:** HS256, signed with your workspace's signing secret. Admins can reveal and rotate it under **Settings → Install**. Rotating it invalidates every outstanding token and signed attachment link.
- **Lifetime:** keep it to about an hour. Tokens valid for more than 7 days (`exp - iat`, or `exp - now` when `iat` is absent) are rejected, as are tokens with an `iat` in the future. Clocks may differ by 30 seconds.

| Claim | Required | Meaning |
| --- | --- | --- |
| `iss` | yes | Your workspace slug. Picks the signing secret. |
| `sub` | yes | The customer's email. Identifies the person. |
| `account_name` | yes | The customer's company, e.g. `"Acme Co"`. |
| `exp` | yes | Expiry, seconds since the epoch. |
| `iat` | recommended | Issued-at, seconds since the epoch. |
| `name` | no | Display name. Defaults to the part of the email before `@`. |
| `role` | no | `"admin"` or `"member"` inside the customer's account. When present it is re-applied on every request, so your product stays the source of truth. When absent, the first person seen on a new account becomes its admin and everyone after is a member. |

The account and the person are created the first time Crumb sees them.

Signing in Node (the **Settings → Install** page has Node, Next.js, Python and other versions filled in with your slug):

```js
import { createHmac } from "node:crypto";

const b64url = (s) => Buffer.from(s).toString("base64url");

export function crumbToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: "your-workspace-slug",
    sub: user.email,
    name: user.name,
    account_name: user.account.name,
    iat: now,
    exp: now + 60 * 60,
  }));
  const sig = createHmac("sha256", process.env.CRUMB_SIGNING_SECRET)
    .update(`${header}.${claims}`)
    .digest("base64url");
  return `${header}.${claims}.${sig}`;
}
```

Token errors (all `401` unless noted):

| Code | Meaning |
| --- | --- |
| `jwt_required` | Cloud only: no token was sent. |
| `invalid_token` | Not a JWT, or its payload has no `iss`. |
| `workspace_not_found` (`404`) | No workspace has the slug in `iss`. |
| `jwt_signature` | Signed with a different secret. |
| `jwt_expired` | `exp` has passed. Mint a fresh token; the widget asks for one through `crumb.onTokenExpired`. |
| `jwt_ttl` | Lifetime longer than 7 days. |
| `jwt_iat` | `iat` is in the future. |
| `jwt_shape`, `jwt_json` | A required claim is missing, or the payload isn't JSON. |

**Self-host fallback (no token).** A self-hosted install also accepts identity sent in the clear, which is handy for demos and trusted internal tools but lets anyone claim any email. Send `workspace` and `email` as query parameters on `GET` requests, and `workspace_slug` and `account_user_email` in request bodies (form fields for uploads). `POST /api/v1/items` and `POST /api/v1/usage-events` also take `account_name` and `account_user_name`, used to create the person on first contact. Errors: `400 missing_workspace_slug`, `400 missing_email`, `404 workspace_not_found`, `404 user_not_found` (unknown email and no `account_name` to create it with). Cloud refuses this path with `401 jwt_required`.

### Workspace API keys (MCP)

API keys let an AI assistant read and triage your workspace over [MCP](#mcp-server).

- Admins create them under **Settings → API keys**. A workspace can hold 20 active keys.
- The full key (`crumb_sk_…`) is shown once, with a Copy button. Crumb stores only a SHA-256 hash.
- A key acts as the teammate who created it, with that person's **current** role: admins and PMs can read and write, viewers can read and post internal notes. Status changes and replies made with the key are attributed to its creator. Demoting the creator narrows the key at once.
- Revoking a key takes effect on the next request. Removing the creator from the team deletes their keys, and the remove dialog lists them first.
- Keys work only on `/api/mcp`. The customer API does not accept them.

```
Authorization: Bearer crumb_sk_…
```

---

## Conventions

**Format.** Requests and responses are JSON (`Content-Type: application/json`) except file uploads, which are `multipart/form-data`. Timestamps are ISO 8601 in UTC. Responses can gain new fields over time, so ignore fields you don't recognize.

**Errors.** A failed call answers with an HTTP status and a stable, snake_case code:

```json
{ "error": "item_not_found" }
```

Codes are for your code, not for people: map them to your own words before showing them. Request-body validation answers `400` with the first failing field's code (`missing_title`, `title_too_long`, and so on). A field sent with the wrong JSON type gets a `400` with a validation message instead of a code.

**Rate limits.** The endpoints in the table below have a token bucket per source IP, and some add a looser bucket per workspace once the caller is identified. A bucket holds a burst of `capacity` requests and refills at `refill` per second. An empty bucket answers:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 4

{ "error": "rate_limited", "retry_after_seconds": 4 }
```

Buckets live in the app's memory (shared through Redis when `CRUMB_REDIS_URL` is set). Endpoints marked "default" use `CRUMB_RATE_LIMIT_CAPACITY` (60) and `CRUMB_RATE_LIMIT_REFILL_PER_SEC` (1); the others are fixed.

| Endpoint | Per IP (capacity / refill per s) | Per workspace |
| --- | --- | --- |
| `POST /api/v1/items` | default | 600 / 10 |
| `POST /api/v1/items/{shortId}` | default | 600 / 10 |
| `POST /api/v1/items/{shortId}/close` | default | 600 / 10 |
| `POST /api/v1/uploads` | 20 / 0.33 | |
| `GET`, `POST /api/v1/roadmap` | 120 / 2 | |
| `GET /api/v1/changelog` | 120 / 2 | |
| `POST /api/v1/notifications` | 60 / 1 | |
| `PATCH`, `DELETE /api/v1/members` | 60 / 1 | |
| `/api/v1/account/integrations/webhook` | default | |
| `POST /api/v1/usage-events` | default | 1200 / 40, plus a monthly cap on Cloud |
| `POST /api/v1/replay-sessions/{token}/chunks` | 120 / 2 | 600 / 20 |
| `POST /api/v1/captures` | 60 / 1 | |
| `POST /api/v1/inbound/*` | 120 / 2 | |
| `POST /api/mcp` | 120 / 2 per API key | |

`GET /api/v1/me`, `GET /api/v1/items`, `GET /api/v1/items/{shortId}` and `GET /api/v1/uploads/{id}` are not rate limited.

The source IP comes from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For` hop. Behind your own proxy, see the README's "Rate limiting" section.

**CORS.** The customer API routes (all but captures and unsubscribe) answer preflights and send `Access-Control-Allow-Origin: *`, allowing `GET, POST, PATCH, DELETE, OPTIONS` with the `Content-Type` and `Authorization` headers, so the widget can call them from your product's origin.

---

## Customer API

Everything here acts for one customer: the person named by the identity token. They see only their own requests and their account's public roadmap and changelog. Auth is the [identity token](#customer-identity-token-customer-api) unless an endpoint says otherwise.

Endpoints:

- [`GET /api/v1/me`](#get-apiv1me): who the caller is, plus workspace settings
- [`GET /api/v1/items`](#get-apiv1items): the caller's requests
- [`POST /api/v1/items`](#post-apiv1items): submit a request
- [`GET /api/v1/items/{shortId}`](#get-apiv1itemsshortid): one request's thread
- [`POST /api/v1/items/{shortId}`](#post-apiv1itemsshortid): reply on a request
- [`POST /api/v1/items/{shortId}/close`](#post-apiv1itemsshortidclose): the customer closes their own request
- [`POST /api/v1/uploads`](#post-apiv1uploads), [`GET /api/v1/uploads/{id}`](#get-apiv1uploadsid): attachments
- [`GET`, `POST /api/v1/roadmap`](#get-apiv1roadmap): public roadmap and following
- [`GET /api/v1/changelog`](#get-apiv1changelog): published changelog
- [`POST /api/v1/notifications`](#post-apiv1notifications): email preferences
- [`PATCH`, `DELETE /api/v1/members`](#patch-apiv1members): account admins manage their teammates
- [`/api/v1/account/integrations/webhook`](#apiv1accountintegrationswebhook): account admins connect their own Slack or Teams channel
- [`POST /api/v1/usage-events`](#post-apiv1usage-events): product usage events (`crumb.track`)
- [`POST /api/v1/replay-sessions/{token}/chunks`](#post-apiv1replay-sessionstokenchunks): session replay (Cloud)
- [`POST /api/v1/captures`](#post-apiv1captures): capture feedback from a browser or email extension
- [`/api/v1/unsubscribe`](#apiv1unsubscribe): unsubscribe links in customer email

Statuses you will see on items:

| Status | Meaning |
| --- | --- |
| `open` | Submitted, not yet looked at. |
| `review` | In review. |
| `planned` | Planned. |
| `progress` | In progress. |
| `shipped` | Shipped. Closes the loop. |
| `declined` | Won't ship. Closes the loop; carries a reason. |
| `deferred` | Set aside for now; carries a reason. |
| `duplicate` | Merged into another item. Closes the loop; carries a reason. |
| `resolved` | The customer closed it themselves. Closes the loop. |

### `GET /api/v1/me`

The caller, their account, and the workspace settings the widget needs. The first call from a real customer also marks the widget as installed in your setup checklist.

Response `200`:

```json
{
  "has_roadmap": true,
  "email_enabled": true,
  "user": { "id": "3f0c…", "name": "Pat Lee", "email": "pat@acme.com", "initials": "PL", "role": "admin" },
  "notifications": { "replies": true, "status": true, "roadmap": true, "unsubscribed_all": false },
  "workspace": {
    "slug": "southbeam",
    "name": "Southbeam",
    "accent": "#E27D3A",
    "launcher_bg": "#1C1815",
    "launcher_edge": "right",
    "launcher_visibility": "auto",
    "launcher_offset_y": 0,
    "session_record_enabled": false,
    "usage_tracking_enabled": true
  },
  "account": { "id": "8a21…", "name": "Acme Co", "member_count": 3 },
  "is_account_admin": true,
  "members": [
    { "id": "3f0c…", "name": "Pat Lee", "email": "pat@acme.com", "initials": "PL", "role": "admin", "item_count": 4 }
  ]
}
```

- `has_roadmap`: the workspace has at least one public initiative on the roadmap.
- `email_enabled`: this deployment can send email. When false, notification preferences do nothing.
- `members` is filled only for account admins (empty otherwise). Its ids are what [`/api/v1/members`](#patch-apiv1members) takes.

Errors: the token errors above, `404 account_not_found`.

### `GET /api/v1/items`

The caller's own requests, most recently active first. Not paginated.

Response `200`:

```json
{
  "items": [
    {
      "short_id": "FB-42",
      "title": "CSV export times out on large accounts",
      "body": "Anything over 50k rows fails after a minute.",
      "type": "bug",
      "status": "planned",
      "created_at": "2026-01-01T12:00:00.000Z",
      "updated_at": "2026-01-03T09:30:00.000Z",
      "reply_count": 3,
      "last_reply_side": "vendor",
      "turn": "waiting",
      "last_event": { "kind": "reply", "at": "2026-01-03T09:30:00.000Z", "author_name": "Dana Reyes" },
      "vendor_reply_count": 1,
      "last_vendor_reply_at": "2026-01-03T09:30:00.000Z"
    }
  ]
}
```

- `reply_count` counts visible messages, including the customer's own (their original text is the first message).
- `last_reply_side`: who moved last. `"vendor"` when your team's latest touch is newer than the customer's latest message (a reply, a status email that was delivered, or setting the request aside), `"customer"` when the customer wrote last, or `null` when neither has happened.
- `turn` is from your team's side: `"yours"` (your team owes the next move), `"waiting"` (your team moved last, per `last_reply_side`) or `"closed"`.
- `last_event` is the latest visible change: `{ "kind": "reply", "at", "author_name" }`, `{ "kind": "status", "at", "status" }`, or `null`.
- `vendor_reply_count` and `last_vendor_reply_at` count only your team's replies, for an unread badge.

### `POST /api/v1/items`

Submit a request as the caller. Sets status `open`.

Request:

```json
{
  "type": "bug",
  "title": "CSV export times out on large accounts",
  "body": "Anything over 50k rows fails after a minute.",
  "attachment_ids": ["5b7e…"],
  "context": {
    "page_url": "https://app.acme.com/reports?tab=export",
    "page_title": "Reports",
    "referrer": "https://app.acme.com/",
    "user_agent": "Mozilla/5.0 …",
    "viewport": { "w": 1440, "h": 900 },
    "locale": "en-US",
    "app_version": "4.2.1"
  },
  "session_token": "<replay session token>"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `bug`, `idea` or `question`. |
| `title` | yes | 1 to 300 characters after trimming. |
| `body` | no | Up to 20,000 characters. Becomes the thread's first message. |
| `attachment_ids` | no | Up to 50 ids from [`POST /api/v1/uploads`](#post-apiv1uploads). Only files the same person uploaded and hasn't attached yet are linked; other ids are ignored. |
| `context` | no | Where the customer was. Best effort: over-long text is cut, malformed fields are dropped, only `http(s)` URLs are kept, and secret-looking query values (`token`, `password`, `code`, `…key` and similar) are replaced with `[redacted]`. Shown to your team on the item. |
| `session_token` | no | Cloud: the 32-hex replay session to link. The widget sends it. |

Response `201`:

```json
{ "id": "c2d4…", "short_id": "FB-43", "status": "open", "created_at": "2026-01-04T10:00:00.000Z" }
```

Errors: `400 invalid_json`, `invalid_type`, `missing_title`, `title_too_long`, `body_too_long`, `invalid_attachment_id`, `invalid_session_token`, `403 submitter_blocked` (your team marked this person's feedback as spam), the token errors, `429 rate_limited`.

### `GET /api/v1/items/{shortId}`

One of the caller's requests with its visible thread. Internal notes are never included.

Response `200`:

```json
{
  "item": {
    "short_id": "FB-42",
    "title": "CSV export times out on large accounts",
    "type": "bug",
    "status": "declined",
    "created_at": "2026-01-01T12:00:00.000Z",
    "updated_at": "2026-01-03T09:30:00.000Z",
    "status_reason": "Exports over 50k rows move to the scheduled-report flow.",
    "status_changed_at": "2026-01-03T09:30:00.000Z"
  },
  "workspace": { "name": "Southbeam" },
  "messages": [
    {
      "id": "0b6f…",
      "kind": "customer",
      "author_name": "Pat Lee",
      "author_initials": "PL",
      "body": "Anything over 50k rows fails after a minute.",
      "created_at": "2026-01-01T12:00:00.000Z",
      "attachments": [
        {
          "id": "5b7e…",
          "filename": "export.png",
          "content_type": "image/png",
          "size_bytes": 48211,
          "url": "https://crumb.example.com/api/v1/uploads/5b7e…?exp=1767268800&sig=…"
        }
      ]
    }
  ],
  "events": [
    { "id": "e1…", "from_status": null, "to_status": "open", "reason": null, "at": "2026-01-01T12:00:00.000Z", "by_name": null },
    { "id": "e2…", "from_status": "open", "to_status": "declined", "reason": "Exports over 50k rows move to the scheduled-report flow.", "at": "2026-01-03T09:30:00.000Z", "by_name": "Dana Reyes" }
  ]
}
```

- `kind` is `"vendor"` for your team and `"customer"` for anyone on the customer's account.
- `status_reason` and `status_changed_at` belong to the current status (null when it was set without one).
- `events` always starts with the submission. `by_name` is the teammate who made the change, or null (the submission, and the customer closing it).
- Attachment `url`s are signed links that work for one hour without any other credential.

Errors: `404 item_not_found`, `403 not_your_item` (someone else submitted it), the token errors.

### `POST /api/v1/items/{shortId}`

Reply on one of the caller's requests. Replies from customers are always visible to both sides.

Request:

```json
{ "body": "Still happening on 4.2.1.", "attachment_ids": ["5b7e…"] }
```

Send `body` (up to 20,000 characters), `attachment_ids` (up to 50), or both. Your team is notified.

Response `201`:

```json
{ "id": "7d3a…", "created_at": "2026-01-04T10:05:00.000Z" }
```

Errors: `400 missing_body` (neither text nor attachments), `400 body_too_long`, `404 item_not_found`, `403 not_your_item`, `403 submitter_blocked`, the token errors, `429 rate_limited`.

### `POST /api/v1/items/{shortId}/close`

The caller closes their own request ("I'm all set"), moving it to `resolved`. Repeating the call is harmless.

Request (optional body):

```json
{ "reason": "Found the setting, thanks." }
```

Response `200`:

```json
{ "status": "resolved" }
```

Errors: `409 already_closed` (your team already shipped, declined or merged it), `404 item_not_found`, `403 not_your_item`, `400 reason_too_long`, the token errors, `429 rate_limited`.

### `POST /api/v1/uploads`

Upload one file to attach to a new request or a reply. Send `multipart/form-data` with a single `file` field (on the self-host fallback, add `workspace_slug` and `account_user_email` fields). A signed-in dashboard session also works, for your team's own uploads.

- Up to 10 MB.
- Allowed types: `image/*`, `text/*`, `application/pdf`, `application/json`, `application/zip`, Word and Excel (`application/msword`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.*`).
- Attach it by passing the id in `attachment_ids` on the next submit or reply. Files still unattached after an hour are deleted by the [maintenance sweep](#maintenance-jobs).

Response `201`:

```json
{ "id": "5b7e…", "filename": "export.png", "content_type": "image/png", "size_bytes": 48211 }
```

Errors: `400 bad_multipart`, `400 missing_file`, `400 empty_file`, `413 file_too_large`, `415 unsupported_type`, the token errors, `429 rate_limited`.

### `GET /api/v1/uploads/{id}`

Download an attachment. Any one of these grants access:

- a signed link (`?exp=…&sig=…`, as returned in a thread's attachment `url`) that hasn't expired;
- the identity token of the person who submitted the request, or who uploaded a file not yet attached;
- a dashboard session in the same workspace.

Raster images (PNG, JPEG, GIF, WebP, AVIF, BMP) and PDFs open in the browser; everything else downloads. Responses are `Cache-Control: private, max-age=300`.

Errors: `400 bad_id`, `403 forbidden`, `404 not_found`, `404 bytes_not_found`.

### `GET /api/v1/roadmap`

The workspace's public roadmap: initiatives your team marked public and placed in a column.

Response `200`:

```json
{
  "columns": {
    "now": [
      { "id": "1c9e…", "short_id": "IN-7", "name": "Faster exports", "description": "Exports that include every row.", "status": "in_progress", "following": true }
    ],
    "next": [],
    "later": []
  }
}
```

`following` says whether the caller follows the initiative.

### `POST /api/v1/roadmap`

Follow or unfollow a public initiative. Followers are emailed when it moves (if their `roadmap` preference is on).

Request:

```json
{ "initiative_id": "1c9e…", "follow": true }
```

Response `200`:

```json
{ "ok": true, "following": true }
```

Errors: `400 invalid_json`, `400 invalid_request` (missing `initiative_id` or a non-boolean `follow`), `404 initiative_not_found` (unknown or not public), the token errors, `429 rate_limited`.

### `GET /api/v1/changelog`

Published, public changelog entries, newest first.

Response `200`:

```json
{
  "entries": [
    { "id": "4e2b…", "title": "Exports include every row", "body": "Large exports now arrive by email…", "published_at": "2026-01-10T15:00:00.000Z" }
  ]
}
```

### `POST /api/v1/notifications`

Change the caller's email preferences. Send any subset of the booleans.

Request:

```json
{ "replies": true, "status": false, "roadmap": true, "unsubscribed_all": false }
```

`replies`: your team replies. `status`: status changes. `roadmap`: initiatives they follow or asked for. `unsubscribed_all`: mute every email from this workspace.

Response `200`:

```json
{ "ok": true, "notifications": { "replies": true, "status": false, "roadmap": true, "unsubscribed_all": false } }
```

Errors: `400 invalid_json`, `400 no_fields`, the token errors, `429 rate_limited`.

### `PATCH /api/v1/members`

An account admin changes a teammate's role within their own account. The caller must be an admin of the account (`is_account_admin` in [`/me`](#get-apiv1me)).

Request:

```json
{ "target_user_id": "6a0d…", "role": "member" }
```

Response `200`: `{ "ok": true, "role": "member" }`

Errors: `400 invalid_json`, `400 invalid_request`, `403 not_account_admin`, `404 member_not_found`, `409 last_admin` (the account must keep one admin), the token errors, `429 rate_limited`.

### `DELETE /api/v1/members`

An account admin removes a teammate from their account.

Request:

```json
{ "target_user_id": "6a0d…" }
```

Response `200`: `{ "ok": true, "removed": "6a0d…" }`

Errors: `400 invalid_json`, `400 invalid_request`, `403 not_account_admin`, `404 member_not_found`, `409 cannot_remove_self`, `409 last_admin`, `409 has_items` (people who submitted feedback stay, so their requests keep an author), the token errors, `429 rate_limited`.

### `/api/v1/account/integrations/webhook`

An account admin connects their own Slack or Microsoft Teams incoming webhook, so their team sees your replies, status changes and roadmap updates in their channel as well as by email. Identity token only (no self-host fallback); the caller must be an account admin (`403 forbidden` otherwise).

`GET` answers which channels are connected, never the full URL:

```json
{
  "slack": { "connected": true, "masked_url": "hooks.slack.com/…a1b2" },
  "teams": { "connected": false, "masked_url": null }
}
```

`POST` sets one (an empty or `null` `url` clears it):

```json
{ "provider": "slack", "url": "https://hooks.slack.com/services/T000/B000/XXXX" }
```

URLs must be `https` on `hooks.slack.com`, `*.webhook.office.com` or `*.logic.azure.com` (self-host can lift this with `CRUMB_WEBHOOK_ALLOW_ANY=1`). Answers `{ "ok": true }`.

`DELETE ?provider=slack` (or `teams`) clears one and answers `{ "ok": true }`.

Errors: `400 bad_json`, `400 bad_provider`, `400 invalid_url`, `403 forbidden`, the token errors, `429 rate_limited`.

### `POST /api/v1/usage-events`

Product usage events, what `crumb.track(name, props)` in the widget sends in batches. They feed churn signals and **Insights**. Allowed on self-host; on Cloud it needs a plan with usage analytics, and the workspace's `usage_tracking_enabled` (from [`/me`](#get-apiv1me)) says whether to send.

Request:

```json
{
  "events": [
    { "name": "report_exported", "props": { "rows": 52000 }, "ts": "2026-01-04T10:00:00.000Z", "page_url": "https://app.acme.com/reports" }
  ],
  "session_token": "<replay session token>"
}
```

- 1 to 50 events per call. `name` is 1 to 64 characters.
- `props` is an object. Only its first 30 keys are kept, and props over 4 KB of JSON are stored as `{}`.
- `ts` (ISO 8601 with offset) defaults to the time received. `page_url` is redacted like submission context.

Response `202`: `{ "accepted": 1 }`

Errors: `400 no_events`, `400 too_many_events`, `400 missing_event_name`, `400 event_name_too_long`, `400 invalid_session_token`, `403 usage_analytics_not_entitled`, `429 usage_events_cap_reached` (Cloud monthly cap: 500,000 events on Team, 2,000,000 on Growth), the token errors, `429 rate_limited`.

### `POST /api/v1/replay-sessions/{token}/chunks`

Cloud only (the community build doesn't include it). The widget's session recorder uploads rrweb event chunks here when the workspace has session replay on its plan and switched on; you don't call it yourself. `{token}` is the recorder's 32-hex session token, which is also the credential.

Request: `{ "workspace_slug", "sequence", "started_at", "ended_at", "events": [ … ], "page_url"?, "user_agent"?, "viewport_w"?, "viewport_h"?, "screen_w"?, "screen_h"? }`

Response `201`: `{ "session_id": "…", "chunk_id": "…" }`

Errors: `400 invalid_json`, `bad_sequence`, `missing_workspace_slug`, `missing_timing`, `bad_timing`, `missing_events`, `empty_events`, `bad_token`; `403 session_record_not_entitled`, `403 session_record_disabled`; `404 workspace_not_found`; `409 duplicate_sequence`; `410 session_record_cloud_only`; `413 session_too_long`, `session_size_exceeded`, `session_events_exceeded`; `429 replay_monthly_quota_exceeded`, `429 rate_limited`.

### `POST /api/v1/captures`

Capture feedback from a browser or email extension into your **Captures** queue, where your team confirms it onto an account or discards it. It doesn't create an item by itself.

Auth is the workspace's capture address rather than a customer token. With `CRUMB_INBOUND_DOMAIN` and `CRUMB_INBOUND_SECRET` set, **Settings → Install** shows an address `inbox+<slug>.<token>@<domain>`; send its `<slug>` and `<token>` parts.

Request:

```json
{
  "slug": "southbeam",
  "token": "q8Zr…",
  "from_email": "pat@acme.com",
  "from_name": "Pat Lee",
  "subject": "Exports keep failing",
  "body": "Anything over 50k rows fails after a minute."
}
```

`subject` (up to 300 characters) or `body` (up to 20,000) is required.

Response `200`: `{ "ok": true, "captureId": "a91f…" }`

Errors: `400 bad_json`, `400 empty`, `401 unauthorized` (wrong token, or `CRUMB_INBOUND_SECRET` is unset), `404 workspace_not_found`, `429 rate_limited`. Not CORS-enabled: call it from an extension or a server.

### `/api/v1/unsubscribe`

The unsubscribe link in customer emails: `GET /api/v1/unsubscribe?u=<person id>&t=<token>&scope=all|replies|status|roadmap`. `GET` shows a confirmation page and changes nothing (mail scanners open links); the page's button `POST`s back to the same URL. Mail clients' one-click unsubscribe (RFC 8058, `List-Unsubscribe=One-Click`) is honored on `POST`. You only need this to know what the link does.

---

## MCP server

Crumb runs a [Model Context Protocol](https://modelcontextprotocol.io) server so an AI assistant can read and triage your feedback with a [workspace API key](#workspace-api-keys-mcp).

**URL:** `https://<your Crumb origin>/api/mcp`

**Connecting a client.** **Settings → API keys** shows your exact URL and these snippets. For clients that speak HTTP:

```json
{
  "mcpServers": {
    "crumb": {
      "type": "http",
      "url": "https://crumb.example.com/api/mcp",
      "headers": { "Authorization": "Bearer crumb_sk_…" }
    }
  }
}
```

For clients that only speak stdio, bridge with `mcp-remote`:

```bash
npx mcp-remote https://crumb.example.com/api/mcp --header "Authorization: Bearer crumb_sk_…"
```

### Transport and protocol

- Streamable HTTP, stateless: each `POST` carries one JSON-RPC 2.0 message and gets one JSON response. There is no SSE stream and no session id; `GET` and `DELETE` answer `405`.
- Protocol versions: `2025-06-18` (latest), `2025-03-26` and `2024-11-05`. `initialize` answers with the version the client asked for when it is one of these, and with `2025-06-18` otherwise.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications (such as `notifications/initialized`) get `202 Accepted` with no body.
- JSON-RPC batches (arrays) are refused.

Handshake:

```bash
curl -s https://crumb.example.com/api/mcp \
  -H "Authorization: Bearer $CRUMB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"crumb","version":"1.0.0"}}}
```

A tool call:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_items","arguments":{"status":"open","limit":20}}}
```

Every tool answers with one text block holding JSON:

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\n  \"count\": 20,\n  \"items\": [ … ],\n  \"next_cursor\": \"MTc2…\"\n}"}]}}
```

### Errors

| Situation | HTTP | Response |
| --- | --- | --- |
| Missing, unknown or revoked key | `401`, `WWW-Authenticate: Bearer` | JSON-RPC error `-32600`, message `unauthorized` |
| Over the per-key rate limit | `429`, `Retry-After` | JSON-RPC error `-32603`, message `rate_limited` |
| Body isn't JSON | `400` | `-32700` `parse error` |
| A batch | `400` | `-32600` `batch not supported` |
| Unknown method | `200` | `-32601` `method not found: …` |
| Unknown tool | `200` | `-32602` `unknown tool: …` |
| Unexpected server failure | `200` | `-32603` `internal error` |
| The tool ran and failed | `200` | A normal result with `"isError": true` and the reason as its text |

Tool failure reasons:

| Reason | Meaning |
| --- | --- |
| `forbidden` | The key's creator is a viewer. Writes need an admin or PM; viewers can still post internal notes. |
| `not_found` | No item with that `short_id` in this workspace. |
| `bad_status` | Not a status your team can set (customers alone set `resolved`). |
| `reason_required` | `declined`, `deferred` and `duplicate` need a `reason`. |
| `invalid_cursor` | `cursor` isn't a `next_cursor` this server issued. |
| `assignee_not_found` | No teammate in this workspace has that email. |
| `bad_type` | `type` isn't `bug`, `idea` or `question`. |
| `<argument> is required` | A required argument is missing or empty. |
| A sentence | `create_item` validation, e.g. `Enter a valid email for the submitter.` |

### Pagination

`list_items`, `search_items` and `list_accounts` return at most `limit` rows (200 at most) and a `next_cursor`. When `next_cursor` isn't `null`, call the tool again with the same arguments plus `"cursor": "<next_cursor>"` for the next page. Cursors are opaque and continue strictly after the last row you got, so items created between calls never shift or repeat a page.

### Tools

Every tool reads and writes only the key's workspace.

| Tool | Kind | What it does |
| --- | --- | --- |
| [`list_items`](#list_items) | read | Items newest first, filterable |
| [`search_items`](#search_items) | read | Substring search over titles and bodies |
| [`get_item`](#get_item) | read | One item with its full thread and timeline |
| [`list_roadmap`](#list_roadmap) | read | Initiatives by roadmap column |
| [`list_accounts`](#list_accounts) | read | Customer accounts by ARR |
| [`update_item_status`](#update_item_status) | write | Change an item's status |
| [`reply_to_item`](#reply_to_item) | write | Reply to the customer, or add an internal note |
| [`create_item`](#create_item) | write | Log feedback for a customer |
| [`assign_item`](#assign_item) | write | Assign or unassign an item |

Write tools need the key's creator to be an admin or PM (internal notes excepted). They run the same code as the dashboard, so [webhooks](#webhooks), Slack and Teams notifications and customer emails fire exactly as they would there.

#### `list_items`

| Argument | Type | Notes |
| --- | --- | --- |
| `status` | string | One of `open`, `review`, `planned`, `progress`, `shipped`, `declined`, `deferred`, `duplicate`. |
| `type` | string | `bug`, `idea` or `question`. |
| `account` | string | Exact account name. |
| `limit` | integer | Default 50, at most 200. |
| `cursor` | string | `next_cursor` from the previous call. |

```json
{
  "count": 1,
  "items": [
    {
      "short_id": "FB-42",
      "title": "CSV export times out on large accounts",
      "type": "bug",
      "status": "planned",
      "account": "Acme Co",
      "created_at": "2026-01-01T12:00:00.000Z",
      "updated_at": "2026-01-03T09:30:00.000Z"
    }
  ],
  "next_cursor": null
}
```

#### `search_items`

Case-insensitive substring match on title and body; `%` and `_` match literally. Newest first.

| Argument | Type | Notes |
| --- | --- | --- |
| `query` | string | Required. |
| `limit` | integer | Default 25, at most 200. |
| `cursor` | string | `next_cursor` from the previous call. |

Returns `{ count, items, next_cursor }`, with items shaped like `list_items` minus `updated_at`.

#### `get_item`

| Argument | Type | Notes |
| --- | --- | --- |
| `short_id` | string | Required, e.g. `FB-42`. |

```json
{
  "item": {
    "short_id": "FB-42",
    "title": "CSV export times out on large accounts",
    "body": "Anything over 50k rows fails after a minute.",
    "type": "bug",
    "status": "planned",
    "account": "Acme Co",
    "submitter": "Pat Lee",
    "submitter_email": "pat@acme.com",
    "assignee": "Dana Reyes",
    "created_at": "2026-01-01T12:00:00.000Z",
    "updated_at": "2026-01-03T09:30:00.000Z"
  },
  "replies": [
    { "author": "Pat Lee", "kind": "customer", "internal": false, "body": "Anything over 50k rows fails after a minute.", "created_at": "2026-01-01T12:00:00.000Z" },
    { "author": "Dana Reyes", "kind": "vendor", "internal": true, "body": "Same root cause as FB-17.", "created_at": "2026-01-02T08:00:00.000Z" }
  ],
  "timeline": [
    { "from_status": null, "to_status": "open", "reason": null, "by": null, "at": "2026-01-01T12:00:00.000Z" },
    { "from_status": "open", "to_status": "planned", "reason": null, "by": "Dana Reyes", "at": "2026-01-03T09:30:00.000Z" }
  ]
}
```

`replies` includes internal notes (`internal: true`), which the customer never sees. `assignee` is `null` when unassigned.

#### `list_roadmap`

No arguments. Every initiative, grouped:

```json
{
  "now": [{ "short_id": "IN-7", "name": "Faster exports", "description": "Exports that include every row.", "status": "in_progress", "column": "now", "is_public": true }],
  "next": [],
  "later": [],
  "unscheduled": []
}
```

#### `list_accounts`

| Argument | Type | Notes |
| --- | --- | --- |
| `limit` | integer | Default 100, at most 200. |
| `cursor` | string | `next_cursor` from the previous call. |

Highest ARR first:

```json
{ "count": 1, "accounts": [{ "name": "Acme Co", "arr_usd": 48000, "since": "2024-03-01T00:00:00.000Z" }], "next_cursor": null }
```

`since` is when the account became a customer, or `null` when unknown.

#### `update_item_status`

| Argument | Type | Notes |
| --- | --- | --- |
| `short_id` | string | Required. |
| `status` | string | Required. `open`, `review`, `planned`, `progress`, `shipped`, `declined`, `deferred` or `duplicate`. |
| `reason` | string | Required for `declined`, `deferred` and `duplicate`. The customer sees it. |

```json
{ "ok": true, "short_id": "FB-42", "status": "planned", "emailed": true }
```

Only `planned`, `progress`, `shipped`, `declined` and `deferred` email the customer, and only when they can be emailed: they wrote in through the widget, have an address, haven't opted out, and the workspace can send email. `emailed` says whether that email actually went out.

#### `reply_to_item`

| Argument | Type | Notes |
| --- | --- | --- |
| `short_id` | string | Required. |
| `body` | string | Required. |
| `internal` | boolean | `true` for a private team note. Default `false`. |

```json
{ "ok": true, "short_id": "FB-42", "reply_id": "7d3a…", "internal": false, "emailed": true }
```

A customer-facing reply emails the customer under the same conditions as status changes; internal notes never do and are never sent to webhooks.

#### `create_item`

| Argument | Type | Notes |
| --- | --- | --- |
| `account` | string | Required. The customer account's name; created if new. |
| `submitter_email` | string | Required. The customer who raised it; created if new. |
| `submitter_name` | string | Defaults to the part of the email before `@`. |
| `type` | string | Required. `bug`, `idea` or `question`. |
| `title` | string | Required. |
| `body` | string | Optional. |

```json
{ "ok": true, "short_id": "FB-44", "account": "Acme Co" }
```

#### `assign_item`

| Argument | Type | Notes |
| --- | --- | --- |
| `short_id` | string | Required. |
| `assignee_email` | string | A teammate's email. Leave it out (or empty) to unassign. |

```json
{ "ok": true, "short_id": "FB-42", "assignee_email": "dana@southbeam.io" }
```

---

## Webhooks

Crumb POSTs a signed JSON event to your endpoints when something happens in your workspace.

**Setup.** Workspace admins add endpoints under **Settings → Webhooks** (up to 10 per workspace):

- The URL must be `http` or `https`. On Cloud it must resolve to a public address (private, loopback and link-local targets are refused).
- Pick the event types to receive. Every type is ticked to start with, and you can change the selection later. Event types added in later releases aren't ticked on existing endpoints.
- Copy the signing secret when it's shown. Admins can reveal it again or rotate it later.
- **Send test** posts a sample of the endpoint's first subscribed event right away, and each endpoint's delivery log shows its recent attempts with their outcome.

### The request

```
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: Crumb-Webhooks/1
X-Crumb-Event: item.status_changed
X-Crumb-Event-Id: 2f9d0c3e-8b1a-4c57-9e6f-1a2b3c4d5e6f
X-Crumb-Signature: sha256=5d41402abc4b2a76b9719d911017c592…

{"id":"2f9d0c3e-8b1a-4c57-9e6f-1a2b3c4d5e6f","type":"item.status_changed","workspace":"southbeam","item":{"short_id":"FB-42","title":"CSV export times out on large accounts","type":"bug"},"from_status":"open","to_status":"planned","reason":null,"at":"2026-01-01T12:00:00.000Z"}
```

| Header | Value |
| --- | --- |
| `X-Crumb-Event` | The event type, the same as the body's `type`. |
| `X-Crumb-Event-Id` | The event's id, the same as the body's `id`. Unique per event; identical across retries and across your endpoints. |
| `X-Crumb-Signature` | `sha256=` and the hex HMAC-SHA256 of the raw request body, keyed by the endpoint's signing secret. |
| `X-Crumb-Test` | `1` on samples sent with **Send test**. Absent on real events. |

Every body has `id`, `type`, `workspace` (your workspace slug) and `at` (when it happened, ISO 8601), plus the fields of its type below.

### Verifying the signature

Recompute the HMAC over the exact bytes you received (before any JSON parsing) and compare in constant time. In Node with Express:

```js
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = express();

app.post("/crumb-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", process.env.CRUMB_WEBHOOK_SECRET).update(req.body).digest("hex"),
  );
  const got = Buffer.from(req.get("x-crumb-signature") ?? "");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return res.sendStatus(401);

  const event = JSON.parse(req.body.toString("utf8"));
  // Retries reuse event.id: skip ids you've already handled.
  res.sendStatus(204);
});
```

### Delivery

- **Success** is any `2xx` within 10 seconds. Acknowledge first and do slow work afterwards.
- **Redirects** are not followed and count as failures. Use the final URL.
- **Retries:** a timeout, a connection error, a refused target, `429` or any `5xx` is retried twice, about 2 and 10 seconds later, with the same id and body. Other responses (`3xx`, other `4xx`) are final.
- **Duplicates and order:** a retry can arrive after you already processed the event, and events can arrive out of order. Deduplicate on the id and use `at` for ordering.
- **No replay:** retries are held by the running app, so a restart drops any that are pending, and spent events aren't resent.
- **Auto-pause:** after 15 failed events in a row the endpoint is paused. Resume it from **Settings → Webhooks** once your receiver is healthy; that resets the count.
- **Internal notes** are never delivered.

### Event types

| Type | Sent when |
| --- | --- |
| [`item.created`](#itemcreated) | An item was created from the widget, the dashboard, Slack, MCP, an accepted capture or an Autopilot connector. |
| [`item.status_changed`](#itemstatus_changed) | An item moved to a new status, including when the customer closes it. |
| [`item.reply_created`](#itemreply_created) | Your team or the customer replied on an item. |
| [`item.assigned`](#itemassigned) | An item was assigned or unassigned. |
| [`item.merged`](#itemmerged) | An item was merged into another as a duplicate. |
| [`item.external_status_changed`](#itemexternal_status_changed) | The Linear, Jira or GitHub ticket linked to an item changed status in that tracker. |
| [`ticket.linked`](#ticketlinked) | An item was linked to a tracker ticket. |
| [`ticket.unlinked`](#ticketunlinked) | An item's tracker ticket was unlinked. |
| [`customer.notified`](#customernotified) | The customer was emailed about an item. |
| [`initiative.updated`](#initiativeupdated) | An initiative was edited, moved on the roadmap, or made public or private. |
| [`capture.created`](#capturecreated) | Feedback was captured from email, Slack, the extension or a connector, ready for triage. |

Many payloads share an item reference, `"item": { "short_id": "FB-42", "title": "…", "type": "bug" }`, and a ticket reference, `"ticket": { "provider": "linear", "id": "ENG-128", "url": "https://…" }` (`provider` is `linear`, `jira` or `github`; `url` can be `null`). The samples below leave out `id`, `workspace` and `at`.

#### `item.created`

```json
{ "type": "item.created", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "account": "Globex" }
```

`account` is the customer account's name. Feedback an Autopilot connector folds into an existing item as a duplicate doesn't send this event (that item isn't new).

#### `item.status_changed`

```json
{ "type": "item.status_changed", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "from_status": "open", "to_status": "planned", "reason": null }
```

`to_status` is any [status](#customer-api), including `resolved` when the customer closed it. `reason` is set when one was given. `from_status` can be `null`.

#### `item.reply_created`

```json
{ "type": "item.reply_created", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "reply": { "id": "0b6f7a52-4c1e-4f0e-9a51-3d2f1b7e9c11", "internal": false, "author": "Dana Reyes", "is_customer": false } }
```

`is_customer` tells which side wrote it. `internal` is always `false` here, since internal notes aren't delivered.

#### `item.assigned`

```json
{ "type": "item.assigned", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "assignee": { "id": "5d1c2e9a-7b3f-4a8e-b6d4-2f9e8c7a1b30", "name": "Dana Reyes" } }
```

`assignee` is `null` when the item was unassigned.

#### `item.merged`

```json
{ "type": "item.merged", "item": { "short_id": "FB-57", "title": "CSV export times out on large accounts", "type": "bug" }, "into": { "short_id": "FB-42" } }
```

`item` is the duplicate; `into` is the item it now lives under.

#### `item.external_status_changed`

```json
{ "type": "item.external_status_changed", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "ticket": { "provider": "linear", "id": "ENG-128", "url": "https://linear.app/acme/issue/ENG-128" }, "from_status": "In Progress", "to_status": "Done" }
```

The statuses are the tracker's own names. Either can be `null`.

#### `ticket.linked`

```json
{ "type": "ticket.linked", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "ticket": { "provider": "linear", "id": "ENG-128", "url": "https://linear.app/acme/issue/ENG-128" } }
```

#### `ticket.unlinked`

```json
{ "type": "ticket.unlinked", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "ticket": { "provider": "linear", "id": "ENG-128", "url": "https://linear.app/acme/issue/ENG-128" } }
```

`ticket` is the one the item was linked to.

#### `customer.notified`

```json
{ "type": "customer.notified", "item": { "short_id": "FB-42", "title": "CSV export times out on large accounts", "type": "bug" }, "notification": { "kind": "status", "channel": "email", "to_status": "shipped" } }
```

`kind` is `reply` (your team's reply was emailed) or `status` (a status change was, with `to_status`; `null` for replies). `channel` is `email`.

#### `initiative.updated`

```json
{ "type": "initiative.updated", "initiative": { "short_id": "IN-7", "name": "Faster exports", "status": "in_progress", "roadmap_column": "now" }, "changes": ["roadmap_column"] }
```

`initiative` is the state after the edit. `changes` names the fields it touched: `name`, `description`, `internal_notes`, `status`, `color`, `owner`, `tracked_events`, `roadmap_column` or `is_public` (shown on, or taken off, the public roadmap). `roadmap_column` is `now`, `next`, `later` or `null`.

#### `capture.created`

```json
{ "type": "capture.created", "capture": { "id": "9a3e5c71-2b84-4d6f-8e10-6c4b2a9d7f58", "source": "email", "subject": "Exports keep failing", "status": "pending" } }
```

`source` says where it came from: `email`, `slack`, `extension`, or a connector (`gong`, `zendesk`, `intercom`, `freshdesk`, `freshchat`). `status` is usually `pending`; Autopilot can land one already decided.

---

## Operator endpoints

For whoever runs the Crumb install. None of these take a customer token or an API key.

### Inbound email

Point your mail provider's inbound webhook (Resend Inbound, SendGrid Inbound Parse, Postmark, Mailgun routes) at these, with `CRUMB_INBOUND_DOMAIN` and `CRUMB_INBOUND_SECRET` set. When `CRUMB_INBOUND_SECRET` is set, both require:

```
Authorization: Bearer <CRUMB_INBOUND_SECRET>
```

Both take the same JSON shape: `{ "to": string | string[], "from": string, "text": string, "subject"?: string, "html"?: string, "message_id"?: string }`. Quoted earlier messages are stripped from `text`, and bodies are cut to 20,000 characters. Rate limit 120 / 2 per IP.

**`POST /api/v1/inbound/reply`** turns a customer's emailed reply into a reply on the thread. `to` must contain the signed reply address (`reply+<shortId>.<token>@<domain>`) that every notification email uses as Reply-To, and the sender must be a person on that item's customer account.

- `200 { "ok": true, "accepted": true, "shortId": "FB-42" }`
- `200 { "ok": true, "accepted": false, "reason": "unknown_sender" }`: dropped on purpose, without an error, so the provider doesn't retry.
- Errors: `400 bad_json`, `no_reply_address`, `no_sender`, `empty_body`, `empty_after_quote_strip`; `401 unauthorized`; `403 invalid_token`; `404 item_not_found`.

**`POST /api/v1/inbound/email`** turns mail sent or forwarded to the capture address (`inbox+<slug>.<token>@<domain>`, shown on **Settings → Install**) into a pending capture.

- `200 { "ok": true, "captureId": "a91f…" }`
- Errors: `400 bad_json`, `no_inbox_address`, `empty`; `401 unauthorized`; `403 invalid_token`; `404 workspace_not_found`.

### Maintenance jobs

Call these from your scheduler with the shared secret:

```
POST /api/v1/internal/<job>
X-Crumb-Sweep-Secret: <CRUMB_INTERNAL_SWEEP_SECRET>
```

| Job | Does | Suggested cadence |
| --- | --- | --- |
| `replay-sweep` | Prunes unlinked replay sessions, unattached uploads and aged usage events, and renews Jira status webhooks on Cloud. Optional body `{ "graceMs": 86400000, "limit": 500 }`. | Hourly |
| `crm-sync` | Refreshes accounts and ARR from connected HubSpot or Salesforce. | Every 6 hours |
| `feedback-sync` | Pulls new conversations from connected feedback sources (Autopilot). | Every 15 to 60 minutes |
| `digest` | Emails each teammate's daily or weekly digest (at most one per period), then embeds items AI-entitled workspaces still lack on Cloud. | Daily |

They answer `503 sweep_secret_unset` until the secret is set and `401 unauthorized` for a wrong one.

### Health

- `GET /api/health`: liveness, always `200 { "ok": true }` while the process serves.
- `GET /api/health/ready`: readiness, `200 { "ok": true, "db": "up" }` when Postgres answers, otherwise `503 { "ok": false, "db": "down" }`.

### Provider callbacks

`/api/v1/stripe/webhook` (Cloud billing) and the routes under `/api/integrations/<provider>/` (OAuth callbacks, Slack commands and events, and Linear, Jira and GitHub status webhooks) are called by those providers. The README's integration sections say how to register them.

### Dashboard-internal routes

`/api/v1/feed`, `/api/v1/ask` and the replay viewer's `GET`/`POST` routes under `/api/v1/replay-sessions/{id}/` serve the dashboard itself, need a signed-in dashboard session, and may change without notice. Don't build on them.
