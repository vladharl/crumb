import { NextResponse } from "next/server";
import { db, items, accountUsers, workspaceUsers, replies, statusEvents, attachments } from "@crumb/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { notifyVendorsOfCustomerReply, dashboardOriginFromHeaders } from "@/lib/customer-reply-notify";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { createReplySchema, parseJsonBody } from "@/lib/validation";
import { emitEvent } from "@/lib/webhooks";
import { log } from "@/lib/log";
import { signedAttachmentPath } from "@/lib/attachments/signed-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Auth: matches /api/v1/items — JWT required on Cloud, trusted-email
// fallback allowed only on self-host. Enforcement lives in resolveCustomer.
// Rate-limited per-IP at the top + per-workspace after auth.

export function OPTIONS() {
  return preflight();
}

// ─── GET /api/v1/items/[shortId]?workspace=...&email=... ───────
// Returns the thread (item + non-internal replies). The caller must be the
// item's submitter (until auth lands).
export async function GET(req: Request, { params }: { params: { shortId: string } }) {
  const url = new URL(req.url);
  const r = await resolveCustomer(req, {
    workspaceSlug: url.searchParams.get("workspace"),
    email: url.searchParams.get("email"),
  });
  if (!r.ok) return fail(r.status, r.error);

  const [item] = await db
    .select()
    .from(items)
    .where(and(
      eq(items.workspaceId, r.ctx.workspace.id),
      eq(items.shortId, params.shortId),
    ))
    .limit(1);
  if (!item) return fail(404, "item_not_found");
  if (item.submitterId !== r.ctx.user.id) return fail(403, "not_your_item");

  // pull non-internal messages, joined to author tables
  const msgs = await db
    .select({
      id: replies.id,
      body: replies.body,
      createdAt: replies.createdAt,
      vendorName: workspaceUsers.name,
      vendorInitials: workspaceUsers.initials,
      customerName: accountUsers.name,
      customerInitials: accountUsers.initials,
    })
    .from(replies)
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, replies.workspaceUserId))
    .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
    .where(and(eq(replies.itemId, item.id), eq(replies.internal, false)))
    .orderBy(asc(replies.createdAt));

  // attachments linked to any visible (non-internal) reply
  const replyIdList = msgs.map(m => m.id);
  const attachmentRows = replyIdList.length === 0 ? [] : await db
    .select({
      id: attachments.id,
      replyId: attachments.replyId,
      filename: attachments.filename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(inArray(attachments.replyId, replyIdList));
  const attsByReply = new Map<string, typeof attachmentRows>();
  for (const a of attachmentRows) {
    if (!a.replyId) continue;
    const arr = attsByReply.get(a.replyId) ?? [];
    arr.push(a);
    attsByReply.set(a.replyId, arr);
  }

  // pull status events with the actor's display name
  const events = await db
    .select({
      id: statusEvents.id,
      fromStatus: statusEvents.fromStatus,
      toStatus: statusEvents.toStatus,
      reason: statusEvents.reason,
      at: statusEvents.at,
      byName: workspaceUsers.name,
    })
    .from(statusEvents)
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, statusEvents.byWorkspaceUserId))
    .where(eq(statusEvents.itemId, item.id))
    .orderBy(asc(statusEvents.at));

  // status_events only records transitions made through the dashboard, so a
  // seeded / pre-table item can have a partial trail (e.g. just "review →
  // planned") or none at all. Always anchor the timeline with a synthesized
  // "Submitted" step at the item's creation time, unless the first recorded
  // event is already the initial one (from_status === null). This guarantees
  // every step shows a date instead of collapsing to the latest status.
  const mappedEvents = events.map(e => ({
    id: e.id,
    from_status: e.fromStatus,
    to_status: e.toStatus,
    reason: e.reason,
    at: e.at,
    by_name: e.byName,
  }));
  const hasInitialEvent = mappedEvents.length > 0 && mappedEvents[0]!.from_status === null;
  const timeline = hasInitialEvent ? mappedEvents : [
    {
      id: "synth-submitted",
      from_status: null as string | null,
      to_status: "open",
      reason: null as string | null,
      at: item.createdAt,
      by_name: null as string | null,
    },
    ...mappedEvents,
  ];

  // The current status's reason (why it was declined / set aside / merged) and
  // when, lifted out of the timeline so the widget can show them without the
  // expanded rail. Only when the latest event IS the current status: a status
  // written without an event (capture-time merges) must not borrow an older one.
  const latest = timeline[timeline.length - 1]!;
  const current = latest.to_status === item.status ? latest : null;

  // Attachment links are signed + short-lived: the widget opens them in a new
  // tab, which can't send the JWT, and the customer's email stays out of URLs.
  const origin = dashboardOriginFromHeaders(req) ?? "";

  return cors(NextResponse.json({
    item: {
      short_id: item.shortId,
      title: item.title,
      type: item.type,
      status: item.status,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      status_reason: current?.reason ?? null,
      status_changed_at: current?.at ?? null,
    },
    workspace: {
      name: r.ctx.workspace.name,
    },
    messages: msgs.map(m => ({
      id: m.id,
      kind: m.vendorName ? "vendor" : "customer",
      author_name: m.vendorName ?? m.customerName ?? "—",
      author_initials: m.vendorInitials ?? m.customerInitials ?? "·",
      body: m.body,
      created_at: m.createdAt,
      attachments: (attsByReply.get(m.id) ?? []).map(a => ({
        id: a.id,
        filename: a.filename,
        content_type: a.contentType,
        size_bytes: a.sizeBytes,
        url: origin + signedAttachmentPath(a.id, r.ctx.workspace.signingSecret),
      })),
    })),
    events: timeline,
  }));
}

// ─── POST /api/v1/items/[shortId]/replies via this path ────────
// Same shortId guarded by submitter; replies are always non-internal.
export async function POST(req: Request, { params }: { params: { shortId: string } }) {
  const rl = await checkRateLimitAsync(`reply:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const parsed = await parseJsonBody(req, createReplySchema);
  if (!parsed.ok) return fail(parsed.status, parsed.error);
  const payload = parsed.data;

  const r = await resolveCustomer(req, {
    workspaceSlug: payload.workspace_slug ?? null,
    email: payload.account_user_email ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);
  // Marked as spam: turned away like their new requests (POST /api/v1/items).
  if (r.ctx.user.blockedAt) return fail(403, "submitter_blocked");

  // Per-workspace bucket — both must pass; looser cap than the per-IP one.
  const wsRl = await checkRateLimitAsync(`reply:ws:${r.ctx.workspace.id}`, { capacity: 600, refillPerSec: 10 });
  if (!wsRl.ok) return tooManyRequests(wsRl.retryAfterSeconds);

  const body = (payload.body ?? "").trim();
  const attachmentIds = (payload.attachment_ids ?? []).filter(Boolean);
  // Reply needs either text or an attachment.
  if (!body && attachmentIds.length === 0) return fail(400, "missing_body");

  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, r.ctx.workspace.id), eq(items.shortId, params.shortId)))
    .limit(1);
  if (!item) return fail(404, "item_not_found");
  if (item.submitterId !== r.ctx.user.id) return fail(403, "not_your_item");

  const [created] = await db.insert(replies).values({
    itemId: item.id,
    accountUserId: r.ctx.user.id,
    body,
    internal: false,
  }).returning();

  // Link any attachments the same customer uploaded (and haven't yet
  // attached to a reply). Restricting by account_user_id prevents a
  // malicious customer from grabbing someone else's draft upload.
  if (attachmentIds.length > 0 && created) {
    await db
      .update(attachments)
      .set({ replyId: created.id })
      .where(and(
        inArray(attachments.id, attachmentIds),
        isNull(attachments.replyId),
        eq(attachments.uploadedByAccountUserId, r.ctx.user.id),
      ));
  }

  await db.update(items).set({ updatedAt: new Date() }).where(eq(items.id, item.id));

  // Outbound webhook fan-out: a customer answered from the widget.
  if (created) {
    void emitEvent(r.ctx.workspace.id, {
      type: "item.reply_created",
      workspace: r.ctx.workspace.slug,
      item: { short_id: item.shortId, title: item.title, type: item.type },
      reply: { id: created.id, internal: false, author: r.ctx.user.name, is_customer: true },
      at: new Date().toISOString(),
    });
  }

  // Notify the vendor team, best-effort and not awaited: lib/email paces
  // sends, so a few admins' emails would hold the customer's reply open.
  void notifyVendorsOfCustomerReply({
    itemId: item.id,
    customerName: r.ctx.user.name,
    replyBody: body,
    dashboardOrigin: dashboardOriginFromHeaders(req),
  }).catch((err) => {
    log.error("widget-reply notify failed", { scope: "crumb/widget-reply", err });
  });

  return cors(NextResponse.json({
    id: created!.id,
    created_at: created!.createdAt,
  }, { status: 201 }));
}
