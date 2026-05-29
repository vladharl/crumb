import { NextResponse } from "next/server";
import { db, items, accountUsers, workspaceUsers, replies, statusEvents, attachments } from "@crumb/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { notifyVendorsOfCustomerReply, dashboardOriginFromHeaders } from "@/lib/customer-reply-notify";
import { callerIpFromRequest, checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

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

  // Synthesize a "Submitted" event if none exists (for items created before
  // the status_events table landed).
  const submittedEvent = events.length === 0 ? [{
    id: "synth-submitted",
    from_status: null as string | null,
    to_status: "open",
    reason: null as string | null,
    at: item.createdAt,
    by_name: null as string | null,
  }] : [];

  return cors(NextResponse.json({
    item: {
      short_id: item.shortId,
      title: item.title,
      type: item.type,
      status: item.status,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
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
      })),
    })),
    events: events.length > 0
      ? events.map(e => ({
          id: e.id,
          from_status: e.fromStatus,
          to_status: e.toStatus,
          reason: e.reason,
          at: e.at,
          by_name: e.byName,
        }))
      : submittedEvent,
  }));
}

type ReplyBody = {
  workspace_slug?: string;
  account_user_email?: string;
  body?: string;
  attachment_ids?: string[];
};

// ─── POST /api/v1/items/[shortId]/replies via this path ────────
// Same shortId guarded by submitter; replies are always non-internal.
export async function POST(req: Request, { params }: { params: { shortId: string } }) {
  const rl = checkRateLimit(`reply:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let payload: ReplyBody;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }

  const r = await resolveCustomer(req, {
    workspaceSlug: payload.workspace_slug ?? null,
    email: payload.account_user_email ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);

  // Per-workspace bucket — both must pass; looser cap than the per-IP one.
  const wsRl = checkRateLimit(`reply:ws:${r.ctx.workspace.id}`, { capacity: 600, refillPerSec: 10 });
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

  // Notify the vendor team — best-effort, never blocks the response.
  try {
    await notifyVendorsOfCustomerReply({
      itemId: item.id,
      customerName: r.ctx.user.name,
      replyBody: body,
      dashboardOrigin: dashboardOriginFromHeaders(req),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/widget-reply] notify failed:", err);
  }

  return cors(NextResponse.json({
    id: created!.id,
    created_at: created!.createdAt,
  }, { status: 201 }));
}
