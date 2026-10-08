import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secret-match";
import { and, desc, eq } from "drizzle-orm";
import { db, items, accountUsers, replies, workspaces } from "@crumb/db";
import { parseReplyAddress, pickReplyTarget } from "@/lib/reply-token";
import { extractSender, extractSenderName, normalizeMessageId, stripQuotedTail } from "@/lib/inbound-text";
import { createInboundCapture } from "@/lib/captures";
import { notifyVendorsOfCustomerReply, dashboardOriginFromHeaders } from "@/lib/customer-reply-notify";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/validation";
import { emitEvent } from "@/lib/webhooks";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── POST /api/v1/inbound/reply ────────────────────────────────
// Provider-agnostic webhook for inbound email replies. The mail server
// (Resend Inbound, SendGrid Inbound Parse, Postmark, Mailgun routes, etc.)
// POSTs a JSON shape we normalize from below. The required fields:
//
//   to:       string | string[]    — must include the signed reply address
//   from:     string               — sender (display name + addr allowed)
//   text:     string               — plain-text body
//
// Optional: subject, html, message_id / messageId. The Message-ID is the
// dedupe key: a provider retry of a message that already landed is answered
// { accepted: false, reason: "duplicate" } instead of posting it twice.
//
// Auth (optional): set CRUMB_INBOUND_SECRET to require
//   Authorization: Bearer <secret>
// on every request. Leave unset in dev to skip the check.

// Most items a reply address's shortId is checked against (see POST).
const REPLY_CANDIDATE_CAP = 1000;

type InboundPayload = {
  to?: string | string[];
  from?: string;
  text?: string;
  subject?: string;
  html?: string;
  message_id?: string;
  messageId?: string;
};

function pickReplyAddress(to: InboundPayload["to"]): { shortId: string; token: string } | null {
  if (!to) return null;
  const list = Array.isArray(to) ? to : [to];
  for (const cand of list) {
    const parsed = parseReplyAddress(cand);
    if (parsed) return parsed;
  }
  return null;
}

function authorized(req: Request): boolean {
  const required = process.env.CRUMB_INBOUND_SECRET?.trim();
  if (!required) return true;
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return secretMatches(auth.slice(7).trim(), required);
}

export async function POST(req: Request) {
  // Mail providers retry on failures; a generous limit per source IP keeps
  // legitimate retries flowing while still blocking obvious abuse from
  // any one origin.
  const rl = await checkRateLimitAsync(`inbound:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: InboundPayload;
  try {
    payload = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = pickReplyAddress(payload.to);
  if (!parsed) return NextResponse.json({ error: "no_reply_address" }, { status: 400 });

  const senderEmail = extractSender(payload.from);
  if (!senderEmail) return NextResponse.json({ error: "no_sender" }, { status: 400 });

  const bodyRaw = payload.text?.trim();
  if (!bodyRaw) return NextResponse.json({ error: "empty_body" }, { status: 400 });
  const stripped = stripQuotedTail(bodyRaw);
  if (!stripped) return NextResponse.json({ error: "empty_after_quote_strip" }, { status: 400 });
  // Cap to the same length as widget replies. Truncate (not reject) — a 4xx
  // would just make the mail provider retry the same oversized payload.
  const body = stripped.length > LIMITS.reply ? stripped.slice(0, LIMITS.reply) : stripped;

  // FB numbers are only unique per workspace, so on Cloud this shortId can name
  // an item in many workspaces. Load them all (joined to the workspace for its
  // signing secret) and keep the one whose secret signed the token.
  // ponytail: capped at REPLY_CANDIDATE_CAP workspaces sharing one FB number,
  // newest activity first (replies answer recent notification emails), so past
  // the cap only stale threads fall off. Upgrade path if that ever bites: match
  // the HMAC in SQL (pgcrypto hmac()) or put a workspace hint in new addresses.
  const candidates = await db
    .select({
      itemId: items.id,
      itemTitle: items.title,
      itemType: items.type,
      itemWorkspaceId: items.workspaceId,
      itemAccountId: items.accountId,
      workspaceSlug: workspaces.slug,
      signingSecret: workspaces.signingSecret,
    })
    .from(items)
    .innerJoin(workspaces, eq(workspaces.id, items.workspaceId))
    .where(eq(items.shortId, parsed.shortId))
    .orderBy(desc(items.updatedAt))
    .limit(REPLY_CANDIDATE_CAP);

  if (candidates.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const row = pickReplyTarget(parsed.shortId, parsed.token, candidates);
  if (!row) {
    if (candidates.length === REPLY_CANDIDATE_CAP) {
      log.warn("inbound reply token matched none of the capped candidates", { scope: "crumb/inbound", shortId: parsed.shortId });
    }
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  }

  const messageId = normalizeMessageId(payload.message_id ?? payload.messageId);
  if (!messageId) {
    log.warn("inbound reply has no Message-ID, so a provider retry would post it twice", { scope: "crumb/inbound", shortId: parsed.shortId });
  }

  // Only a known account_user on this account posts to the thread: the signed
  // address proves which thread, not who is writing. Submitter is the common
  // case but any account teammate works.
  const [author] = await db
    .select({ id: accountUsers.id, name: accountUsers.name })
    .from(accountUsers)
    .where(and(
      eq(accountUsers.workspaceId, row.itemWorkspaceId),
      eq(accountUsers.accountId, row.itemAccountId),
      eq(accountUsers.email, senderEmail),
    ))
    .limit(1);

  // Anyone else (a colleague not on the account yet, a personal address, an
  // auto-responder) waits in captures for a person to review, naming the
  // thread it answered, instead of vanishing. Still a 200: a 5xx would retry.
  if (!author) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.itemWorkspaceId)).limit(1);
    if (!ws) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    const captureId = await createInboundCapture(ws, {
      source: "email",
      fromEmail: senderEmail,
      fromName: extractSenderName(payload.from),
      subject: payload.subject?.trim().slice(0, 300) || null,
      body: `Emailed reply to ${parsed.shortId} (${row.itemTitle}) from an address that isn't on its account.\n\n${body}`.slice(0, LIMITS.reply),
      externalId: messageId, // a retry is a no-op on the captures' unique index
      rawMeta: { message_id: messageId, reply_to: parsed.shortId },
    });
    return NextResponse.json(captureId
      ? { ok: true, accepted: false, reason: "unknown_sender", captureId }
      : { ok: true, accepted: false, reason: "duplicate" });
  }

  const [created] = await db.insert(replies).values({
    itemId: row.itemId,
    accountUserId: author.id,
    body,
    internal: false,
    inboundMessageId: messageId,
  })
    .onConflictDoNothing({ target: [replies.itemId, replies.inboundMessageId] })
    .returning({ id: replies.id });
  // A retry of a message that already landed: nothing new to post or tell anyone.
  if (!created) return NextResponse.json({ ok: true, accepted: false, reason: "duplicate" });

  await db.update(items).set({ updatedAt: new Date() }).where(eq(items.id, row.itemId));

  // Outbound webhook fan-out: a customer answered by email.
  void emitEvent(row.itemWorkspaceId, {
    type: "item.reply_created",
    workspace: row.workspaceSlug,
    item: { short_id: parsed.shortId, title: row.itemTitle, type: row.itemType },
    reply: { id: created.id, internal: false, author: author.name, is_customer: true },
    at: new Date().toISOString(),
  });

  // Notify the vendor team, best-effort and not awaited: the provider gets its
  // 200 now, so a slow mail or Slack send can't time the webhook out into a retry.
  void notifyVendorsOfCustomerReply({
    itemId: row.itemId,
    customerName: author.name,
    replyBody: body,
    dashboardOrigin: dashboardOriginFromHeaders(req),
  }).catch((err) => {
    log.error("inbound-reply notify failed", { scope: "crumb/inbound-reply", err });
  });

  return NextResponse.json({ ok: true, accepted: true, shortId: parsed.shortId });
}
