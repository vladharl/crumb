import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secret-match";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { parseInboxAddress, verifyInboxToken } from "@/lib/inbound-address";
import { captureFromEmail, normalizeMessageId } from "@/lib/inbound-text";
import { createInboundCapture } from "@/lib/captures";
import { isBlockedSender } from "@/lib/items/delete";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/validation";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── POST /api/v1/inbound/email ────────────────────────────────
// Forwarded-email capture ("meet customers where they are"). A vendor forwards
// (or auto-routes) a customer email to the per-workspace inbox address
// `inbox+<slug>.<token>@<CRUMB_INBOUND_DOMAIN>`. We DON'T create an item; we
// create a PENDING capture with an AI-suggested account (Cloud-only) for the
// vendor to confirm in the Inbox. A forward is attributed to the customer named
// in its forwarded header block, not the teammate who forwarded it (see
// captureFromEmail). Provider-agnostic JSON shape, same as /api/v1/inbound/reply;
// a retry with the same message_id is answered { accepted: false, reason: "duplicate" }.

type InboundPayload = {
  to?: string | string[];
  from?: string;
  text?: string;
  subject?: string;
  html?: string;
  message_id?: string;
  messageId?: string;
};

function authorized(req: Request): boolean {
  const required = process.env.CRUMB_INBOUND_SECRET?.trim();
  if (!required) return true; // dev: skip
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return secretMatches(auth.slice(7).trim(), required);
}

function pickInboxAddress(to: InboundPayload["to"]): { slug: string; token: string } | null {
  if (!to) return null;
  const list = Array.isArray(to) ? to : [to];
  for (const cand of list) {
    const p = parseInboxAddress(cand);
    if (p) return p;
  }
  return null;
}

export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`inbound:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: InboundPayload;
  try {
    payload = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = pickInboxAddress(payload.to);
  if (!parsed) return NextResponse.json({ error: "no_inbox_address" }, { status: 400 });
  if (!verifyInboxToken(parsed.slug, parsed.token)) {
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  }

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, parsed.slug)).limit(1);
  if (!ws) return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });

  const mail = captureFromEmail(payload);
  // From a customer whose feedback was marked as spam: no capture, and still
  // a 200 so the provider doesn't retry.
  if (await isBlockedSender(ws.id, mail.fromEmail)) {
    log.info("inbound email from a blocked sender dropped", { scope: "crumb/inbound", workspaceId: ws.id });
    return NextResponse.json({ ok: true, accepted: false, reason: "blocked" });
  }
  const subject = mail.subject?.slice(0, 300) || null;
  const body = mail.body.slice(0, LIMITS.reply);
  if (!subject && !body) return NextResponse.json({ error: "empty" }, { status: 400 });

  const messageId = normalizeMessageId(payload.message_id ?? payload.messageId);
  const captureId = await createInboundCapture(ws, {
    source: "email",
    fromEmail: mail.fromEmail,
    fromName: mail.fromName,
    subject,
    body,
    // A provider retry of this message is a no-op on (workspace, source, external_id).
    externalId: messageId,
    rawMeta: { message_id: messageId },
  });
  if (!captureId) return NextResponse.json({ ok: true, accepted: false, reason: "duplicate" });

  return NextResponse.json({ ok: true, captureId });
}
