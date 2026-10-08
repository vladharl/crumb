import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { verifyInboxToken } from "@/lib/inbound-address";
import { createInboundCapture } from "@/lib/captures";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── POST /api/v1/captures ─────────────────────────────────────
// Authenticated inbound capture for the browser/email extension (a thin future
// client — not shipped in-repo). Auth via the workspace inbox token (the same
// secret that signs the inbox+<slug>.<token>@… email address), so the extension
// is configured with one value. Creates a PENDING capture reviewed at /captures.
//   body: { slug, token, source?, from_email?, from_name?, subject?, body }

type Body = {
  slug?: string;
  token?: string;
  source?: string;
  from_email?: string;
  from_name?: string;
  subject?: string;
  body?: string;
};

export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`captures:${callerIpFromRequest(req)}`, { capacity: 60, refillPerSec: 1 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const slug = b.slug?.trim().toLowerCase();
  const token = b.token?.trim();
  if (!slug || !token || !verifyInboxToken(slug, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  if (!ws) return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });

  const subject = b.subject?.trim().slice(0, 300) || null;
  const body = (b.body ?? "").trim().slice(0, LIMITS.reply);
  if (!subject && !body) return NextResponse.json({ error: "empty" }, { status: 400 });

  const captureId = await createInboundCapture(ws, {
    source: "extension",
    fromEmail: b.from_email?.trim().toLowerCase() || null,
    fromName: b.from_name?.trim() || null,
    subject,
    body,
    rawMeta: { via: "captures-api" },
  });

  // No external id here, so null can only mean the sender was marked as spam:
  // accepted and dropped, like the inbound email routes.
  if (captureId === null) return NextResponse.json({ ok: true, accepted: false, reason: "blocked" });
  return NextResponse.json({ ok: true, captureId });
}
