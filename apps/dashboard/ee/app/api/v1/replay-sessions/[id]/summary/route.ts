import { NextResponse } from "next/server";
import { db, replaySummaries } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { hasFeature } from "@/lib/entitlements";
import { getManifest } from "@/lib/replay/read";
import { extractActionTrace } from "@/lib/replay/summarize";
import { summarizeSession, replaySummaryConfigured, REPLAY_SUMMARY_MODEL } from "@/lib/ai/replay-summary";
import { withAiBudget } from "@/lib/ai/run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cloud-only: generate (POST) an AI summary for a replay session. Lives under
// ee/ so it's stripped on self-host. Entitlement + monthly metering happen via
// withAiBudget. Persists to replay_summaries (1:1 with the session).
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const { workspace } = await getActiveSession();
  if (!replaySummaryConfigured() || !hasFeature(workspace, "ai")) {
    return NextResponse.json({ error: "not_entitled" }, { status: 403 });
  }

  const sessionId = params.id;
  const manifest = await getManifest(sessionId, workspace.id);
  if (!manifest) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const trace = await extractActionTrace(sessionId, workspace.id);
  if (!trace) return NextResponse.json({ error: "no_events" }, { status: 400 });

  const budget = await withAiBudget(workspace, () =>
    summarizeSession(trace.trace, { pageUrl: manifest.pageUrl, durationMs: manifest.durationMs }),
  );
  if (!budget.ok) {
    return NextResponse.json({ error: budget.error }, { status: budget.error === "ai_cap_reached" ? 429 : 403 });
  }
  if (!budget.value) return NextResponse.json({ error: "summary_failed" }, { status: 400 });

  const { summary, highlights } = budget.value;
  await db
    .insert(replaySummaries)
    .values({ sessionId, summary, highlights, model: REPLAY_SUMMARY_MODEL })
    .onConflictDoUpdate({
      target: replaySummaries.sessionId,
      set: { summary, highlights, model: REPLAY_SUMMARY_MODEL, createdAt: new Date() },
    });

  return NextResponse.json({ summary, highlights });
}
