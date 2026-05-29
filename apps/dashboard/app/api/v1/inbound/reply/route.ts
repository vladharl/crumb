import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, items, accountUsers, replies, workspaces } from "@crumb/db";
import { parseReplyAddress, verifyReplyToken } from "@/lib/reply-token";
import { notifyVendorsOfCustomerReply, dashboardOriginFromHeaders } from "@/lib/customer-reply-notify";
import { callerIpFromRequest, checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

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
// Optional: subject, html, message_id / messageId.
//
// Auth (optional): set CRUMB_INBOUND_SECRET to require
//   Authorization: Bearer <secret>
// on every request. Leave unset in dev to skip the check.

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

function extractSender(from: string | undefined): string | null {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  const addr = (angle ? angle[1]! : from).trim().toLowerCase();
  if (!addr.includes("@")) return null;
  return addr;
}

// Strip quoted reply / forward blocks. Conservative — only the lines we're
// confident are quoted history. Keeps everything above the first marker.
function stripQuotedTail(text: string): string {
  const lines = text.split(/\r?\n/);
  const markers: RegExp[] = [
    /^On\s.+\s+wrote:\s*$/i,
    /^-----Original Message-----\s*$/i,
    /^From:\s.+/i,
    /^>+\s/,
  ];
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (markers.some(re => re.test(line))) { cutAt = i; break; }
  }
  return lines.slice(0, cutAt).join("\n").trimEnd();
}

function authorized(req: Request): boolean {
  const required = process.env.CRUMB_INBOUND_SECRET?.trim();
  if (!required) return true;
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return auth.slice(7).trim() === required;
}

export async function POST(req: Request) {
  // Mail providers retry on failures; a generous limit per source IP keeps
  // legitimate retries flowing while still blocking obvious abuse from
  // any one origin.
  const rl = checkRateLimit(`inbound:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
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
  const body = stripQuotedTail(bodyRaw);
  if (!body) return NextResponse.json({ error: "empty_after_quote_strip" }, { status: 400 });

  // Look up the item by shortId, joining its workspace for the signing secret.
  const [row] = await db
    .select({
      itemId: items.id,
      itemTitle: items.title,
      itemWorkspaceId: items.workspaceId,
      itemAccountId: items.accountId,
      signingSecret: workspaces.signingSecret,
    })
    .from(items)
    .innerJoin(workspaces, eq(workspaces.id, items.workspaceId))
    .where(eq(items.shortId, parsed.shortId))
    .limit(1);

  if (!row) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  if (!verifyReplyToken(parsed.shortId, parsed.token, row.signingSecret)) {
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  }

  // The sender must be a known account_user on this account. We don't
  // auto-create — that would let any spammer post into a thread by guessing
  // the address. Submitter is the common case but any account teammate works.
  const [author] = await db
    .select({ id: accountUsers.id, name: accountUsers.name })
    .from(accountUsers)
    .where(and(
      eq(accountUsers.workspaceId, row.itemWorkspaceId),
      eq(accountUsers.accountId, row.itemAccountId),
      eq(accountUsers.email, senderEmail),
    ))
    .limit(1);

  if (!author) {
    // Don't 5xx — provider would retry. Log + accept-but-drop semantics.
    // eslint-disable-next-line no-console
    console.warn(`[crumb/inbound] dropping reply from unknown sender ${senderEmail} for ${parsed.shortId}`);
    return NextResponse.json({ ok: true, accepted: false, reason: "unknown_sender" });
  }

  await db.insert(replies).values({
    itemId: row.itemId,
    accountUserId: author.id,
    body,
    internal: false,
  });

  await db.update(items).set({ updatedAt: new Date() }).where(eq(items.id, row.itemId));

  // Notify the vendor team — best-effort.
  try {
    await notifyVendorsOfCustomerReply({
      itemId: row.itemId,
      customerName: author.name,
      replyBody: body,
      dashboardOrigin: dashboardOriginFromHeaders(req),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/inbound-reply] notify failed:", err);
  }

  return NextResponse.json({ ok: true, accepted: true, shortId: parsed.shortId });
}
