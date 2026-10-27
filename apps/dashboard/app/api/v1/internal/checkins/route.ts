import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secret-match";
import { sendCheckins } from "@/lib/checkin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Operator cron for the 24-hour check-in email (lib/checkin.ts). Same auth as
// the digest. Run it hourly; each workspace gets it at most once. Sends only
// with CRUMB_CHECKIN_EMAILS=1 and CRUMB_OPS_EMAIL set; otherwise, or with
// ?dry=1, it just lists who's due.
//
//   curl -X POST -H "X-Crumb-Sweep-Secret: $CRUMB_INTERNAL_SWEEP_SECRET" \
//     "https://your-crumb-host/api/v1/internal/checkins?dry=1"
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
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  return NextResponse.json(await sendCheckins({ dryRun }));
}
