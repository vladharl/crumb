import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secret-match";
import { sendDigests } from "@/lib/vendor-notify";
import { backfillAllEmbeddings } from "@/lib/ai/backfill-embeddings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Operator cron for the daily and weekly email digest (lib/vendor-notify.ts).
// Same auth as replay-sweep: the CRUMB_INTERNAL_SWEEP_SECRET shared secret in
// the X-Crumb-Sweep-Secret header, and 503 until it's set. Run it once a day;
// a member never gets more than one digest per period, however often it runs.
// The daily run also embeds the items AI-entitled workspaces still lack (say,
// from before an upgrade), so dedup and Similar items cover them. Daily, not
// hourly: an item whose embedding keeps failing costs one AI unit per run.
//
//   curl -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" \
//     https://your-crumb-host/api/v1/internal/digest
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
  const digests = await sendDigests();
  // An overlapping run (a double-fired cron) leaves the backfill to the first.
  if ("busy" in digests) return NextResponse.json(digests);
  // Last, as the slowest.
  const embeddings = await backfillAllEmbeddings();
  return NextResponse.json({ ...digests, embeddings });
}
