import "server-only";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, items, webhookDeliveries, webhookEndpoints, workspaces, type WebhookEndpoint } from "@crumb/db";
import { isCloud } from "./tier";
import { EVENT_TYPES, isEventType, type EventType } from "./event-catalog";
import { LOOP_CLOSED_STATUSES, ticketDone } from "./loop";
import { notifyEngDone } from "./vendor-notify";
import { log } from "./log";

// Re-export the client-safe catalog so server callers can keep importing it
// from here (the historical home).
export { EVENT_TYPES, isEventType };
export type { EventType };

// Outbound webhooks + the internal event seam. Vendors register HTTPS
// endpoints, each subscribed to one or more event types; when something
// happens to an item we POST a signed JSON event to every endpoint that
// subscribed to that type. Best-effort and fire-and-forget from the mutation
// that triggered it — never block or fail the write on a slow or down
// endpoint. Failed attempts are retried a couple of times, every attempt is
// logged (webhook_deliveries), and a chronically failing endpoint auto-pauses
// so we stop hammering it.

const TIMEOUT_MS = 10_000;
export const MAX_FAILURES = 15; // failed events in a row before auto-pause
const RETRY_DELAYS_MS = [2_000, 10_000]; // waits before attempts 2 and 3
const LOG_KEEP = 100; // delivery-log rows kept per endpoint

export function newWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

// ─── SSRF guard ──────────────────────────────────────────────
// On Cloud (multi-tenant), a workspace admin could otherwise register a
// webhook URL pointing at internal infrastructure — cloud metadata
// (169.254.169.254), localhost, RFC1918 ranges — and have our server POST to
// it. We resolve the host and refuse private/loopback/link-local targets.
// Self-host is single-tenant (the admin owns the box and may legitimately
// target their own internal services), so the guard is Cloud-only.

function ipIsPrivate(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;            // this-net, RFC1918, loopback
    if (a === 172 && b >= 16 && b <= 31) return true;             // RFC1918
    if (a === 192 && b === 168) return true;                       // RFC1918
    if (a === 169 && b === 254) return true;                       // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
    if (a >= 224) return true;                                     // multicast + reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;              // loopback / unspecified
  if (lower.startsWith("fe80")) return true;                       // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  return false;
}

// Whether a URL is safe to deliver to. Cloud-only enforcement; resolves the
// host and rejects when any resolved address is private. (Resolve-then-fetch
// leaves a narrow DNS-rebinding window — acceptable for an admin-configured,
// signed, non-credentialed POST; documented as a follow-up.)
export async function isDeliverableUrl(url: string): Promise<boolean> {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname;
  } catch {
    return false;
  }
  if (!isCloud()) return true; // self-host owns its network
  if (net.isIP(host)) return !ipIsPrivate(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => !ipIsPrivate(a.address));
  } catch {
    return false;
  }
}

// ─── event catalog ───────────────────────────────────────────
// Every event shares { type, workspace (slug), at (ISO) }; delivery adds a
// stable `id` (uuid, also sent as X-Crumb-Event-Id, the same on every retry).
// `item.status_changed` keeps the exact shape it shipped with so existing
// receivers don't break. New types extend the catalog; an endpoint only
// receives types it's subscribed to (webhook_endpoints.events[]). Every type is
// documented, with a sample payload, by EVENT_DOCS below.

type ItemRef = { short_id: string; title: string; type: string };
// provider: "linear" | "jira" | "github"; url is the ticket's web page.
type TicketRef = { provider: string; id: string; url: string | null };
type CrumbEventBase = { workspace: string; at: string };

export type CrumbEvent =
  | (CrumbEventBase & { type: "item.created"; item: ItemRef; account: string })
  | (CrumbEventBase & {
      type: "item.status_changed";
      item: ItemRef;
      from_status: string | null;
      to_status: string;
      reason: string | null;
    })
  | (CrumbEventBase & {
      type: "item.reply_created";
      item: ItemRef;
      // `internal` notes are never delivered to outbound endpoints (private);
      // the field is carried so a future in-process subscriber can see them.
      reply: { id: string; internal: boolean; author: string; is_customer: boolean };
    })
  | (CrumbEventBase & { type: "item.assigned"; item: ItemRef; assignee: { id: string; name: string } | null })
  | (CrumbEventBase & { type: "item.merged"; item: ItemRef; into: { short_id: string } })
  // A linked tracker ticket (Linear/Jira/GitHub) changed status on its side.
  | (CrumbEventBase & {
      type: "item.external_status_changed";
      item: ItemRef;
      ticket: TicketRef;
      from_status: string | null;
      to_status: string | null;
    })
  | (CrumbEventBase & { type: "ticket.linked"; item: ItemRef; ticket: TicketRef })
  | (CrumbEventBase & { type: "ticket.unlinked"; item: ItemRef; ticket: TicketRef })
  // Mirrors a customer_notifications ledger row: the customer was told.
  | (CrumbEventBase & {
      type: "customer.notified";
      item: ItemRef;
      notification: { kind: "reply" | "status"; channel: "email"; to_status: string | null };
    })
  // `changes` names the fields this edit touched (snake_case: name,
  // description, internal_notes, status, color, owner, tracked_events,
  // roadmap_column); `initiative` is the state after it.
  | (CrumbEventBase & {
      type: "initiative.updated";
      initiative: { short_id: string; name: string; status: string; roadmap_column: string | null };
      changes: string[];
    })
  // A new inbound capture (email, Slack, extension, connector) landed for
  // triage. status is usually "pending"; autopilot can land one already decided.
  | (CrumbEventBase & {
      type: "capture.created";
      capture: { id: string; source: string; subject: string | null; status: string };
    });

// Compile-time guard: the runtime EVENT_TYPES catalog and the CrumbEvent union
// must name exactly the same set of types. If they drift, this stops building.
type _CatalogMatchesUnion =
  CrumbEvent["type"] extends EventType
    ? EventType extends CrumbEvent["type"] ? true : never
    : never;
const _catalogMatchesUnion: _CatalogMatchesUnion = true;
void _catalogMatchesUnion;

// HMAC-SHA256 over the raw body, hex, `sha256=` prefixed (GitHub-style).
// Receivers recompute this with their endpoint secret to verify authenticity.
function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ─── delivery ────────────────────────────────────────────────
// A timeout, network error, refused target, 429 or 5xx is retried after
// RETRY_DELAYS_MS; anything else (2xx, 3xx, other 4xx) is final. Every attempt
// is a webhook_deliveries row (the settings log). The endpoint row keeps the
// final outcome, and failure_count counts failed events, not attempts.
// ponytail: retries live in this process, so a restart drops pending ones and
// nothing replays an event once its attempts are spent. Persist the body and
// retry from the maintenance sweep if receivers need more than that.

// Why an attempt got no usable response. Stored in webhook_deliveries.error;
// describeDelivery() turns it into words.
type DeliveryError = "timeout" | "network" | "blocked";
type Attempt = { status: number | null; ok: boolean; error: DeliveryError | null; durationMs: number | null };

const retryable = (a: Attempt) => a.error !== null || a.status === 429 || (a.status ?? 0) >= 500;

function headersFor(ep: WebhookEndpoint, eventId: string, eventType: EventType, body: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-crumb-event": eventType,
    "x-crumb-event-id": eventId,
    "x-crumb-signature": sign(ep.secret, body),
    "user-agent": "Crumb-Webhooks/1",
  };
}

async function attemptOnce(ep: WebhookEndpoint, headers: Record<string, string>, body: string): Promise<Attempt> {
  const started = Date.now();
  // Re-check at delivery time, not just create time: DNS can change. A refused
  // or unresolvable target is a failed attempt like any other.
  if (!(await isDeliverableUrl(ep.url))) return { status: null, ok: false, error: "blocked", durationMs: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers,
      body,
      // Never follow: the guard above vetted ep.url, not wherever a 30x
      // points (e.g. 169.254.169.254). A 3xx counts as a failed delivery.
      redirect: "manual",
      signal: ctrl.signal,
    });
    void res.body?.cancel().catch(() => {}); // never read; free the socket
    return { status: res.status, ok: res.status >= 200 && res.status < 300, error: null, durationMs: Date.now() - started };
  } catch {
    return { status: null, ok: false, error: ctrl.signal.aborted ? "timeout" : "network", durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// The log is for humans: losing a row (or a prune) must not stop a delivery.
async function logAttempt(endpointId: string, eventId: string, eventType: EventType, attempt: number, a: Attempt): Promise<void> {
  try {
    await db.insert(webhookDeliveries).values({
      endpointId, eventId, eventType, attempt,
      httpStatus: a.status, ok: a.ok, error: a.error, durationMs: a.durationMs,
    });
  } catch (err) {
    log.warn("webhook delivery log write failed", { scope: "crumb/webhooks", err });
  }
}

// Newest LOG_KEEP rows per endpoint, none older than 30 days.
// ponytail: pruned when the endpoint gets a delivery, so a quiet endpoint keeps
// its last ≤LOG_KEEP rows. Add a global 30-day sweep if that ever matters.
async function pruneLog(endpointId: string): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM webhook_deliveries
      WHERE endpoint_id = ${endpointId}
        AND (created_at < now() - interval '30 days'
          OR id NOT IN (SELECT id FROM webhook_deliveries WHERE endpoint_id = ${endpointId}
                        ORDER BY created_at DESC LIMIT ${LOG_KEEP}))
    `);
  } catch (err) {
    log.warn("webhook delivery log prune failed", { scope: "crumb/webhooks", err });
  }
}

async function deliverOne(ep: WebhookEndpoint, eventId: string, eventType: EventType, body: string): Promise<void> {
  const headers = headersFor(ep, eventId, eventType, body);
  let a: Attempt;
  for (let n = 1; ; n++) {
    a = await attemptOnce(ep, headers, body);
    await logAttempt(ep.id, eventId, eventType, n, a);
    if (a.ok || !retryable(a) || n > RETRY_DELAYS_MS.length) break;
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[n - 1]));
  }

  // The streak is counted in SQL, not from `ep` (read before up to ~40 s of
  // retries), so concurrent failed events all count and a re-enable made
  // meanwhile (which resets it to 0) isn't overwritten.
  await db
    .update(webhookEndpoints)
    .set({
      lastStatus: a.status,
      lastAttemptAt: new Date(),
      ...(a.ok
        ? { failureCount: 0 }
        : {
            failureCount: sql`${webhookEndpoints.failureCount} + 1`,
            // Auto-pause an endpoint that keeps failing; the vendor re-enables
            // it from settings once their receiver is healthy. Never sets
            // `true`, so a pause made meanwhile stays.
            active: sql`CASE WHEN ${webhookEndpoints.failureCount} + 1 >= ${MAX_FAILURES} THEN false ELSE ${webhookEndpoints.active} END`,
          }),
    })
    .where(eq(webhookEndpoints.id, ep.id));

  if (!a.ok) {
    log.warn("webhook delivery failed", { scope: "crumb/webhooks", endpointId: ep.id, status: a.status, error: a.error });
  }
  await pruneLog(ep.id);
}

// Deliver one event to every active endpoint on the workspace that subscribed
// to its type. Internal-note reply events are private and never delivered to
// outbound endpoints. Safe to `void` — all errors are swallowed per-endpoint.
export async function deliverEvent(workspaceId: string, event: CrumbEvent): Promise<void> {
  if (event.type === "item.reply_created" && event.reply.internal) return;

  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(and(
      eq(webhookEndpoints.workspaceId, workspaceId),
      eq(webhookEndpoints.active, true),
      // Only endpoints subscribed to this event type. `events` is a text[];
      // `:type = ANY(events)` is the array-membership test.
      sql`${event.type} = ANY(${webhookEndpoints.events})`,
    ));
  if (endpoints.length === 0) return;
  // One id per event, the same for every endpoint and every retry, so a
  // receiver can drop duplicates.
  const id = randomUUID();
  const body = JSON.stringify({ id, ...event });
  await Promise.all(endpoints.map(ep => deliverOne(ep, id, event.type, body).catch(() => {})));
}

// The internal event seam every mutation calls. Today it only fans out to
// outbound webhooks; keeping the indirection means a future in-process
// subscriber (analytics, push notifications, MCP notifications) can hook in
// here without touching any call site. Fire-and-forget — callers `void` it.
export async function emitEvent(workspaceId: string, event: CrumbEvent): Promise<void> {
  await deliverEvent(workspaceId, event);
}

// Plain-words outcome of one attempt, for the settings log and "Send test".
export function describeDelivery(d: { ok: boolean; httpStatus: number | null; error: string | null }): string {
  if (d.ok) return "Delivered";
  if (d.error === "timeout") return `No response within ${TIMEOUT_MS / 1000} seconds`;
  if (d.error === "blocked") return "The URL did not resolve to a public address";
  if (d.error || d.httpStatus === null) return "Could not connect to the URL";
  if (d.httpStatus >= 300 && d.httpStatus < 400) return "Answered with a redirect, which is not followed";
  return d.httpStatus >= 500 ? "Your server returned an error" : "Your server rejected the request";
}

// "Send test" in settings: one signed sample of the endpoint's first
// subscribed type, flagged with X-Crumb-Test: 1. A single attempt, so the admin
// sees the result right away. It shows in the delivery log but never touches
// the failure streak, and works on a paused endpoint.
export async function sendTestEvent(
  ep: WebhookEndpoint,
  workspaceSlug: string,
): Promise<{ ok: boolean; status: number | null; message: string }> {
  const type = EVENT_TYPES.find(t => ep.events.includes(t)) ?? "item.status_changed";
  const id = randomUUID();
  const body = JSON.stringify({ id, ...EVENT_DOCS[type].sample, workspace: workspaceSlug, at: new Date().toISOString() });
  const a = await attemptOnce(ep, { ...headersFor(ep, id, type, body), "x-crumb-test": "1" }, body);
  await logAttempt(ep.id, id, type, 1, a);
  await pruneLog(ep.id);
  return { ok: a.ok, status: a.status, message: describeDelivery({ ok: a.ok, httpStatus: a.status, error: a.error }) };
}

// ─── tracker status sync ─────────────────────────────────────
// The linked items a tracker event is about: those holding the ticket's
// stable id, plus rows linked before ids were stored (no uid yet) that match
// `legacy`, the route's old key (or URL) match. A key never matches a row
// that has an id, so a key that moved on can't pull in the wrong item.
export function byTicket(uid: string | null | undefined, legacy: SQL): SQL {
  return uid
    ? or(eq(items.externalTicketUid, uid), and(isNull(items.externalTicketUid), legacy))!
    : legacy;
}

// The Linear/Jira/GitHub status webhooks: set external_status on the items
// `where` matches (the route's tenant scoping) and emit
// item.external_status_changed for each one whose status actually moved. When
// it moved to a done state on a loop that's still open, the team hears it
// (notifyEngDone): engineering finished, so someone should tell the customer.
// `ticket` is the ticket as the tracker describes it now. Its uid fills in
// rows linked before ids were stored; its key and URL replace the stored ones,
// which a move or rename changes (an https URL only: the thread links to it).
// ponytail: read-then-update, so two near-simultaneous deliveries for one
// ticket can report a stale from_status. Fine for a notification.
export async function syncExternalStatus(
  where: SQL | undefined,
  toStatus: string | null,
  ticket?: { uid?: string | null; key: string; url?: string | null },
): Promise<void> {
  const linked = await db
    .select({
      id: items.id,
      status: items.status,
      workspaceId: items.workspaceId,
      slug: workspaces.slug,
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      provider: items.externalProvider,
      ticketId: items.externalTicketId,
      ticketUrl: items.externalTicketUrl,
      fromStatus: items.externalStatus,
    })
    .from(items)
    .innerJoin(workspaces, eq(workspaces.id, items.workspaceId))
    .where(where);
  if (linked.length === 0) return;

  const url = ticket?.url && URL.canParse(ticket.url) && new URL(ticket.url).protocol === "https:" ? ticket.url : null;
  await db
    .update(items)
    .set({
      externalStatus: toStatus,
      externalSyncedAt: new Date(),
      updatedAt: new Date(),
      ...(ticket ? { externalTicketId: ticket.key } : {}),
      ...(ticket?.uid ? { externalTicketUid: ticket.uid } : {}),
      ...(url ? { externalTicketUrl: url } : {}),
    })
    .where(where);

  const at = new Date().toISOString();
  const engDone: string[] = [];
  for (const r of linked) {
    if (r.fromStatus === toStatus) continue;
    void emitEvent(r.workspaceId, {
      type: "item.external_status_changed",
      workspace: r.slug,
      item: { short_id: r.shortId, title: r.title, type: r.type },
      ticket: { provider: r.provider ?? "", id: ticket?.key ?? r.ticketId ?? "", url: url ?? r.ticketUrl },
      from_status: r.fromStatus,
      to_status: toStatus,
      at,
    });
    // Reaching done, not moving between done states (Jira's Resolved to Closed).
    if (ticketDone(r.provider, toStatus) && !ticketDone(r.provider, r.fromStatus) && !LOOP_CLOSED_STATUSES.has(r.status)) {
      engDone.push(r.id);
    }
  }
  if (engDone.length) void notifyEngDone({ itemIds: engDone });
}

// ─── docs ────────────────────────────────────────────────────
// What each event means plus a sample payload: rendered on the settings page
// and sent by "Send test". Typed against CrumbEvent, so the docs can't drift
// from what is actually emitted.

const ITEM: ItemRef = { short_id: "FB-42", title: "CSV export times out on large accounts", type: "bug" };
const TICKET: TicketRef = { provider: "linear", id: "ENG-128", url: "https://linear.app/acme/issue/ENG-128" };
const AT = "2026-01-01T12:00:00.000Z";

export const EVENT_DOCS: { [K in EventType]: { when: string; sample: Extract<CrumbEvent, { type: K }> } } = {
  "item.created": {
    when: "An item was created from the widget, the dashboard, Slack, MCP, an accepted capture or an Autopilot connector.",
    sample: { type: "item.created", workspace: "acme", item: ITEM, account: "Globex", at: AT },
  },
  "item.status_changed": {
    when: "An item moved to a new status, including when the customer closes it. reason is set when one was given.",
    sample: { type: "item.status_changed", workspace: "acme", item: ITEM, from_status: "open", to_status: "planned", reason: null, at: AT },
  },
  "item.reply_created": {
    when: "Your team or the customer replied on an item (is_customer tells which). Internal notes are never sent.",
    sample: {
      type: "item.reply_created", workspace: "acme", item: ITEM,
      reply: { id: "0b6f7a52-4c1e-4f0e-9a51-3d2f1b7e9c11", internal: false, author: "Dana Reyes", is_customer: false }, at: AT,
    },
  },
  "item.assigned": {
    when: "An item was assigned to a teammate. assignee is null when it was unassigned.",
    sample: {
      type: "item.assigned", workspace: "acme", item: ITEM,
      assignee: { id: "5d1c2e9a-7b3f-4a8e-b6d4-2f9e8c7a1b30", name: "Dana Reyes" }, at: AT,
    },
  },
  "item.merged": {
    when: "An item was merged into another one as a duplicate.",
    sample: { type: "item.merged", workspace: "acme", item: { ...ITEM, short_id: "FB-57" }, into: { short_id: "FB-42" }, at: AT },
  },
  "item.external_status_changed": {
    when: "The Linear, Jira or GitHub ticket linked to an item changed status in that tracker.",
    sample: {
      type: "item.external_status_changed", workspace: "acme", item: ITEM, ticket: TICKET,
      from_status: "In Progress", to_status: "Done", at: AT,
    },
  },
  "ticket.linked": {
    when: "An item was linked to a new Linear, Jira or GitHub ticket.",
    sample: { type: "ticket.linked", workspace: "acme", item: ITEM, ticket: TICKET, at: AT },
  },
  "ticket.unlinked": {
    when: "An item's tracker ticket was unlinked. ticket is the one it was linked to.",
    sample: { type: "ticket.unlinked", workspace: "acme", item: ITEM, ticket: TICKET, at: AT },
  },
  "customer.notified": {
    when: "The customer was emailed about an item: a reply (kind reply) or a status change (kind status, with to_status).",
    sample: {
      type: "customer.notified", workspace: "acme", item: ITEM,
      notification: { kind: "status", channel: "email", to_status: "shipped" }, at: AT,
    },
  },
  "initiative.updated": {
    when: "An initiative was edited, moved to another roadmap column, or made public or private. changes lists the fields that changed.",
    sample: {
      type: "initiative.updated", workspace: "acme",
      initiative: { short_id: "IN-7", name: "Faster exports", status: "in_progress", roadmap_column: "now" },
      changes: ["roadmap_column"], at: AT,
    },
  },
  "capture.created": {
    when: "Feedback was captured from email, Slack, the browser extension or a connector, ready for triage.",
    sample: {
      type: "capture.created", workspace: "acme",
      capture: { id: "9a3e5c71-2b84-4d6f-8e10-6c4b2a9d7f58", source: "email", subject: "Exports keep failing", status: "pending" },
      at: AT,
    },
  },
};
