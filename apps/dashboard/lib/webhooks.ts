import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";
import { db, webhookEndpoints, type WebhookEndpoint } from "@crumb/db";
import { isCloud } from "./tier";
import { EVENT_TYPES, isEventType, type EventType } from "./event-catalog";
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
// endpoint. Each delivery records last_status/failure_count, and a
// chronically failing endpoint auto-pauses so we stop hammering it.

const TIMEOUT_MS = 5000;
const MAX_FAILURES = 15; // ~consecutive failures before auto-pause

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
// Every event shares { type, workspace (slug), at (ISO) } and carries an
// `item` reference. `item.status_changed` keeps the exact shape it shipped with
// so existing receivers don't break. New types extend the catalog; an endpoint
// only receives types it's subscribed to (webhook_endpoints.events[]).

type ItemRef = { short_id: string; title: string; type: string };
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
  | (CrumbEventBase & { type: "item.merged"; item: ItemRef; into: { short_id: string } });

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

async function deliverOne(ep: WebhookEndpoint, eventType: EventType, body: string): Promise<void> {
  // Re-check at delivery time, not just create time — DNS can change and the
  // workspace plan/tier is what matters here.
  if (!(await isDeliverableUrl(ep.url))) {
    await db
      .update(webhookEndpoints)
      .set({ lastStatus: null, lastAttemptAt: new Date(), failureCount: ep.failureCount + 1, active: false })
      .where(eq(webhookEndpoints.id, ep.id));
    log.warn("webhook target refused (private/unresolvable host) — paused", { scope: "crumb/webhooks", url: ep.url });
    return;
  }

  let status = 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-crumb-event": eventType,
          "x-crumb-signature": sign(ep.secret, body),
          "user-agent": "Crumb-Webhooks/1",
        },
        body,
        signal: ctrl.signal,
      });
      status = res.status;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    status = 0; // network error / timeout
  }

  const ok = status >= 200 && status < 300;
  const failureCount = ok ? 0 : ep.failureCount + 1;
  await db
    .update(webhookEndpoints)
    .set({
      lastStatus: status || null,
      lastAttemptAt: new Date(),
      failureCount,
      // Auto-pause an endpoint that keeps failing; the vendor re-enables it
      // from settings once their receiver is healthy.
      active: failureCount >= MAX_FAILURES ? false : ep.active,
    })
    .where(eq(webhookEndpoints.id, ep.id));

  if (!ok) {
    log.warn("webhook delivery failed", { scope: "crumb/webhooks", url: ep.url, status, failureCount });
  }
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
  const body = JSON.stringify(event);
  await Promise.all(endpoints.map(ep => deliverOne(ep, event.type, body).catch(() => {})));
}

// The internal event seam every mutation calls. Today it only fans out to
// outbound webhooks; keeping the indirection means a future in-process
// subscriber (analytics, push notifications, MCP notifications) can hook in
// here without touching any call site. Fire-and-forget — callers `void` it.
export async function emitEvent(workspaceId: string, event: CrumbEvent): Promise<void> {
  await deliverEvent(workspaceId, event);
}
