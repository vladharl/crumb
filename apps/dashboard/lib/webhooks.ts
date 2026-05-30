import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { and, eq } from "drizzle-orm";
import { db, webhookEndpoints, type WebhookEndpoint } from "@crumb/db";
import { isCloud } from "./tier";
import { log } from "./log";

// Outbound webhooks. Vendors register HTTPS endpoints; when an item's status
// changes we POST a signed JSON event. Best-effort and fire-and-forget from
// the status-change action — never block or fail the status write on a slow
// or down endpoint. Each delivery records last_status/failure_count, and a
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

export type StatusChangedEvent = {
  type: "item.status_changed";
  workspace: string; // slug
  item: { short_id: string; title: string; type: string };
  from_status: string | null;
  to_status: string;
  reason: string | null;
  at: string; // ISO timestamp
};

// HMAC-SHA256 over the raw body, hex, `sha256=` prefixed (GitHub-style).
// Receivers recompute this with their endpoint secret to verify authenticity.
function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function deliverOne(ep: WebhookEndpoint, body: string): Promise<void> {
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
          "x-crumb-event": "item.status_changed",
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

// Fan out an item.status_changed event to every active endpoint on the
// workspace. Safe to `void` — all errors are swallowed per-endpoint.
export async function emitStatusChanged(workspaceId: string, event: StatusChangedEvent): Promise<void> {
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.active, true)));
  if (endpoints.length === 0) return;
  const body = JSON.stringify(event);
  await Promise.all(endpoints.map(ep => deliverOne(ep, body).catch(() => {})));
}
