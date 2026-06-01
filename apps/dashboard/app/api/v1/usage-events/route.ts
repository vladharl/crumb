import { NextResponse } from "next/server";
import { db, usageEvents, replaySessions } from "@crumb/db";
import { eq } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { usageAnalyticsAllowed } from "@/lib/entitlements";
import { checkUsageEventsCap, incrementUsage } from "@/lib/usage";
import { isSelfHost } from "@/lib/tier";
import { createUsageEventsSchema, parseJsonBody, sanitizeEventProps } from "@/lib/validation";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public endpoint for the embedded widget's crumb.track(). Mirrors
// /api/v1/items: two-layer rate limit (per-IP pre-auth, per-workspace after
// resolve), the same resolveCustomer chokepoint (JWT on Cloud, trusted-email
// fallback on self-host), then a bulk insert.
//
// Gating: usage_analytics is capability-gated — allowed on self-host, requires
// the plan feature on Cloud. A monthly count cap (Cloud only) bounds cost.

export function OPTIONS() {
  return preflight();
}

export async function POST(req: Request) {
  // Cheap pre-auth reject for spammy clients.
  const rl = await checkRateLimitAsync(`usage:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const parsed = await parseJsonBody(req, createUsageEventsSchema);
  if (!parsed.ok) return fail(parsed.status, parsed.error);
  const { workspace_slug, account_user_email, account_user_name, account_name, session_token, events } = parsed.data;

  const r = await resolveCustomer(req, {
    workspaceSlug: workspace_slug ?? null,
    email: account_user_email ?? null,
    accountName: account_name ?? null,
    userName: account_user_name ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);
  const ws = r.ctx.workspace;
  const user = r.ctx.user;

  if (!usageAnalyticsAllowed(ws)) return fail(403, "usage_analytics_not_entitled");

  // Per-workspace bucket — higher ceiling than items since events are chattier.
  const wsRl = await checkRateLimitAsync(`usage:ws:${ws.id}`, { capacity: 1200, refillPerSec: 40 });
  if (!wsRl.ok) return tooManyRequests(wsRl.retryAfterSeconds);

  // Monthly cost cap (Cloud only; self-host is unmetered).
  const cap = await checkUsageEventsCap(ws, events.length, isSelfHost());
  if (!cap.allowed) return fail(429, "usage_events_cap_reached");

  // Only attach a session token that maps to a real replay session in THIS
  // workspace — otherwise leave null so a stray/forged token can't pollute joins.
  let linkedSessionToken: string | null = null;
  if (session_token) {
    try {
      const [replay] = await db
        .select({ workspaceId: replaySessions.workspaceId })
        .from(replaySessions)
        .where(eq(replaySessions.sessionToken, session_token))
        .limit(1);
      if (replay && replay.workspaceId === ws.id) linkedSessionToken = session_token;
    } catch (err) {
      log.error("usage-events session lookup failed", { scope: "crumb/usage", err });
    }
  }

  const rows = events.map((e) => ({
    workspaceId: ws.id,
    accountId: user.accountId,
    accountUserId: user.id,
    name: e.name.slice(0, 64),
    props: sanitizeEventProps(e.props),
    ts: e.ts ? new Date(e.ts) : new Date(),
    sessionToken: linkedSessionToken,
    pageUrl: e.page_url ?? null,
  }));

  await db.insert(usageEvents).values(rows);

  // Count after a successful insert (unlike AI's count-before, there's no
  // expensive external call to bound — we're bounding stored rows). Self-host
  // doesn't meter.
  if (!isSelfHost()) {
    try { await incrementUsage(ws.id, "usage_events", rows.length); }
    catch (err) { log.error("usage-events metering failed", { scope: "crumb/usage", err }); }
  }

  return cors(NextResponse.json({ accepted: rows.length }, { status: 202 }));
}
