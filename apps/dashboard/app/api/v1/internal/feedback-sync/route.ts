import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, workspaces, integrationConnections } from "@crumb/db";
import { integrationsAllowed } from "@/lib/entitlements";
import { syncDue, syncFeedbackSource } from "@/lib/integrations/feedback/sync";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Operator-facing Autopilot pull (inbound feedback connectors). Pulls new
// records for every connection that is due (syncDue: healthy, or retrying a
// transient failure whose backoff has passed) across all workspaces, runs each
// through the "new & relevant" gate, and lands them in the Inbox. Shares the
// CRUMB_INTERNAL_SWEEP_SECRET auth with the other internal crons.
//
//   curl -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" \
//     https://your-crumb-host/api/v1/internal/feedback-sync
//
// 503 until the secret is set, so a misconfigured cron is loud, not silent.
// Suggested cadence: every ~15-30 min for support desks, hourly for Gong.
// Overlapping runs are safe: each connection is claimed before it syncs.

function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.CRUMB_INTERNAL_SWEEP_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "sweep_secret_unset", hint: "Set CRUMB_INTERNAL_SWEEP_SECRET to enable this endpoint." },
      { status: 503 },
    );
  }
  if (!secretMatches(req.headers.get("x-crumb-sweep-secret"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({ conn: integrationConnections, ws: workspaces })
    .from(integrationConnections)
    .innerJoin(workspaces, eq(workspaces.id, integrationConnections.workspaceId));

  let pulled = 0;
  let skipped = 0;
  const results: Array<Record<string, unknown>> = [];
  for (const { conn, ws } of rows) {
    // A downgraded workspace stops pulling; its settings card shows the
    // connections as paused, with Disconnect. Nothing is written, so syncing
    // resumes if the plan comes back.
    if (!integrationsAllowed(ws) || !syncDue(conn)) {
      skipped++;
      continue;
    }
    const r = await syncFeedbackSource(ws, conn);
    if (r.ok) {
      pulled += r.pulled;
      results.push({ workspace: ws.slug, provider: r.provider, ok: true, pulled: r.pulled, more: r.more, ...r.outcome });
    } else {
      results.push({ workspace: ws.slug, provider: r.provider, ok: false, error: r.error });
    }
  }

  log.info("feedback-sync cron ran", { scope: "crumb/autopilot", connections: rows.length, synced: results.length, skipped, pulled });
  return NextResponse.json({ connections: rows.length, skipped, pulled, results });
}
