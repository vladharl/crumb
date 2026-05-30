import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { sweepOrphanSessions, sweepAgedSessions } from "@/lib/replay/sweep";
import { sweepOrphanAttachments } from "@/lib/attachments/sweep";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Constant-time secret compare. Avoids leaking the secret one byte at a
// time via response-timing. Length-guard first because timingSafeEqual
// throws on unequal-length buffers (and that length check is itself a
// negligible, intended leak).
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Operator-facing endpoint for pruning orphans: replay sessions that never
// linked to an item AND attachments uploaded but never linked to a reply.
// Auth is a shared secret (CRUMB_INTERNAL_SWEEP_SECRET in the env) — there's no
// vendor-user context for a cron job, and tying this to a workspace
// session would block the most common host (Vercel-cron / GitHub Actions).
//
// Usage (operator wires whatever cron they like):
//   curl -X POST \
//     -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" \
//     https://your-crumb-host/api/v1/internal/replay-sweep
//
// The endpoint is a no-op until you set the env var. Without it the route
// returns 503 so a misconfigured cron call doesn't silently delete nothing
// without telling anyone.

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

  // Optional knobs in the body: graceMs, limit. Body is optional — defaults
  // (24h grace, 500-row batch) are the right call for an hourly cron.
  let opts: { graceMs?: number; limit?: number } = {};
  try {
    const text = await req.text();
    if (text) opts = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Run both sweeps. The replay fields stay at the top level for back-compat
  // with any existing cron that reads them; attachment results nest under a
  // new `attachments` key.
  const result = await sweepOrphanSessions(opts);
  const retention = await sweepAgedSessions(opts);
  const attachments = await sweepOrphanAttachments(opts);
  return NextResponse.json({ ...result, retention, attachments });
}
