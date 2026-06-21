import { NextResponse } from "next/server";
import { db, items, statusEvents } from "@crumb/db";
import { and, eq } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { closeItemSchema, parseJsonBody } from "@/lib/validation";
import { emitEvent } from "@/lib/webhooks";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { dashboardOriginFromHeaders } from "@/lib/customer-reply-notify";
import { LOOP_CLOSED_STATUSES } from "@/lib/loop";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── POST /api/v1/items/[shortId]/close ────────────────────────
// The submitter closes ("resolves") their own request from the widget — the
// only customer-initiated status transition. Auth matches the rest of the
// public API (JWT, or workspace_slug + email on self-host); the caller must be
// the item's submitter. Idempotent if already resolved; refused once the vendor
// has closed the loop (shipped/declined/duplicate) so a customer can't reopen
// a delivered outcome by re-closing.

export function OPTIONS() {
  return preflight();
}

export async function POST(req: Request, { params }: { params: { shortId: string } }) {
  const rl = await checkRateLimitAsync(`close:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const parsed = await parseJsonBody(req, closeItemSchema);
  if (!parsed.ok) return fail(parsed.status, parsed.error);
  const payload = parsed.data;

  const r = await resolveCustomer(req, {
    workspaceSlug: payload.workspace_slug ?? null,
    email: payload.account_user_email ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);

  // Per-workspace bucket — looser cap than the per-IP one, same as replies.
  const wsRl = await checkRateLimitAsync(`close:ws:${r.ctx.workspace.id}`, { capacity: 600, refillPerSec: 10 });
  if (!wsRl.ok) return tooManyRequests(wsRl.retryAfterSeconds);

  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.workspaceId, r.ctx.workspace.id), eq(items.shortId, params.shortId)))
    .limit(1);
  if (!item) return fail(404, "item_not_found");
  if (item.submitterId !== r.ctx.user.id) return fail(403, "not_your_item");

  // Already the customer's own close → succeed quietly (idempotent retries from
  // the widget). Vendor-closed loop → 409: the outcome's been decided, the
  // customer can't override it by self-closing.
  if (item.status === "resolved") {
    return cors(NextResponse.json({ status: "resolved" }));
  }
  if (LOOP_CLOSED_STATUSES.has(item.status)) {
    return fail(409, "already_closed");
  }

  const reason = payload.reason?.trim() || null;
  const fromStatus = item.status;

  await db.update(items).set({ status: "resolved", updatedAt: new Date() }).where(eq(items.id, item.id));
  await db.insert(statusEvents).values({
    itemId: item.id,
    fromStatus,
    toStatus: "resolved",
    reason,
    // Customer-initiated: no vendor actor. A null by_workspace_user_id + a
    // "resolved" target is how the timeline reads "the customer closed it".
    byWorkspaceUserId: null,
  });

  // Webhook fan-out — same shape as a vendor status change, so integrations
  // (and any linked external ticket) see the close consistently.
  void emitEvent(r.ctx.workspace.id, {
    type: "item.status_changed",
    workspace: r.ctx.workspace.slug,
    item: { short_id: item.shortId, title: item.title, type: item.type },
    from_status: fromStatus,
    to_status: "resolved",
    reason,
    at: new Date().toISOString(),
  });

  // Vendor firehose — tell the team the customer closed it themselves. Reuses
  // the status-change card; best-effort, never blocks the response.
  try {
    const origin = dashboardOriginFromHeaders(req);
    await notifyWorkspaceChannel(r.ctx.workspace.id, {
      kind: "status_change",
      shortId: item.shortId,
      title: item.title,
      fromStatus,
      toStatus: "resolved",
      reason: reason ? `Closed by the customer: ${reason}` : "Closed by the customer.",
      url: origin ? `${origin}/thread/${item.shortId}` : null,
    });
  } catch (err) {
    log.error("customer-close notify failed", { scope: "crumb/customer-close", err });
  }

  return cors(NextResponse.json({ status: "resolved" }));
}
