import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isNotNull, or } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import type { CrmProvider } from "@/lib/integrations/crm";
import { syncCrmAccounts, type SyncResult } from "@/lib/integrations/crm/sync";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Operator-facing CRM refresh (feature 1). Pulls accounts + ARR for every
// workspace with a connected CRM. Shares the CRUMB_INTERNAL_SWEEP_SECRET auth
// with the replay-sweep cron — no vendor-user context for a cron job.
//
//   curl -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" \
//     https://your-crumb-host/api/v1/internal/crm-sync
//
// 503 until the secret is set, so a misconfigured cron is loud, not silent.
// Each sync pages through the whole CRM, so a run can take minutes on big
// portals. Workspaces whose plan no longer includes integrations come back
// as plan_required (paused) without calling the CRM; a sync that stopped
// partway is logged here and shown on that workspace's settings card.

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
    .select()
    .from(workspaces)
    .where(or(isNotNull(workspaces.hubspotAccessToken), isNotNull(workspaces.salesforceAccessToken)));

  const results: Array<{ workspace: string; provider: CrmProvider } & SyncResult> = [];
  for (const ws of rows) {
    if (ws.hubspotAccessToken) results.push({ workspace: ws.slug, provider: "hubspot", ...(await syncCrmAccounts(ws, "hubspot")) });
    if (ws.salesforceAccessToken) results.push({ workspace: ws.slug, provider: "salesforce", ...(await syncCrmAccounts(ws, "salesforce")) });
  }

  const upserted = results.reduce((n, r) => n + r.upserted, 0);
  const failed = results.filter((r) => !r.ok && r.error !== "plan_required");
  const paused = results.filter((r) => !r.ok && r.error === "plan_required").length;
  if (failed.length) {
    log.warn("crm-sync cron: some syncs didn't complete", {
      scope: "crumb/crm",
      failed: failed.map((r) => ({ workspace: r.workspace, provider: r.provider, error: r.ok ? null : r.error })),
    });
  }
  log.info("crm-sync cron ran", { scope: "crumb/crm", workspaces: rows.length, upserted, failed: failed.length, paused });
  return NextResponse.json({ workspaces: rows.length, upserted, failed: failed.length, paused, results });
}
