import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isNotNull, or } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
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

  let upserted = 0;
  const results: Array<{ workspace: string; provider: string; ok: boolean; upserted?: number; error?: string }> = [];
  for (const ws of rows) {
    if (ws.hubspotAccessToken) {
      const r = await syncCrmAccounts(ws, "hubspot");
      results.push({ workspace: ws.slug, provider: "hubspot", ...r });
      if (r.ok) upserted += r.upserted;
    }
    if (ws.salesforceAccessToken) {
      const r = await syncCrmAccounts(ws, "salesforce");
      results.push({ workspace: ws.slug, provider: "salesforce", ...r });
      if (r.ok) upserted += r.upserted;
    }
  }

  log.info("crm-sync cron ran", { scope: "crumb/crm", workspaces: rows.length, upserted });
  return NextResponse.json({ workspaces: rows.length, upserted, results });
}
