import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secret-match";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { parseInboxAddress, verifyInboxToken } from "@/lib/inbound-address";
import { extractSender, extractSenderName, stripQuotedTail } from "@/lib/inbound-text";
import { createInboundCapture } from "@/lib/captures";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── POST /api/v1/inbound/email ────────────────────────────────
// Forwarded-email capture ("meet customers where they are"). A vendor forwards
// (or auto-routes) a customer email to the per-workspace inbox address
// `inbox+<slug>.<token>@<CRUMB_INBOUND_DOMAIN>`. We DON'T create an item — the
// `From` is often the vendor, not the customer — we create a PENDING capture
// with an AI-suggested account (Cloud-only) for the vendor to confirm at
// /captures. Provider-agnostic JSON shape, same as /api/v1/inbound/reply.

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

  const senderEmail = extractSender(payload.from);
  const senderName = extractSenderName(payload.from);
  const subject = payload.subject?.trim().slice(0, 300) || null;
  const stripped = stripQuotedTail((payload.text ?? "").trim());
  const body = stripped.length > LIMITS.reply ? stripped.slice(0, LIMITS.reply) : stripped;
  if (!subject && !body) return NextResponse.json({ error: "empty" }, { status: 400 });

  const captureId = await createInboundCapture(ws, {
    source: "email",
    fromEmail: senderEmail,
    fromName: senderName,
    subject,
    body,
    rawMeta: { message_id: payload.message_id ?? payload.messageId ?? null },
  });

  return NextResponse.json({ ok: true, captureId });
}
