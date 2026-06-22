import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db, items, replies, replyMentions, attachments, statusEvents,
  accountUsers, workspaceUsers, workspaces, customerNotifications,
} from "@crumb/db";
import { emitEvent } from "@/lib/webhooks";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { notifyAccountChannels } from "@/lib/notify/account-channel";
import { sendReplyNotification, sendStatusChangeNotification } from "@/lib/email";
import { notifyMentioned, parseMentionIds } from "@/lib/mention-notify";
import { buildReplyAddress } from "@/lib/reply-token";
import { autoNotifiesSubmitter } from "@/lib/feedback/source";
import { log } from "@/lib/log";

// Session-free cores of the vendor-side item mutations (status / reply /
// assign). The cookie-bound server actions (thread/[shortId]/actions.ts) and
// the MCP write tools both call these with an explicit actor, so the DB write,
// the status_events row, the event emit, and the customer/chat notifications
// fire identically no matter who invoked them.
//
// IMPORTANT: these run outside a request/render scope when called from MCP, so
// they must NOT call revalidatePath()/headers()/cookies(). The caller supplies
// `origin` as a plain string (built from headers() in a server action, or from
// the inbound Request in the MCP route); revalidatePath stays in the action
// wrapper. See lib/origin.ts.

export type Status =
  | "open" | "review" | "planned" | "progress"
  | "shipped" | "declined" | "deferred" | "duplicate"
  // Customer-initiated close, set only via the widget's close endpoint — never
  // a vendor-settable status (deliberately absent from ALLOWED_STATUSES below).
  | "resolved";

export const STATUS_LABELS: Record<Status, string> = {
  open:      "Open",
  review:    "In review",
  planned:   "Planned",
  progress:  "In progress",
  shipped:   "Shipped",
  declined:  "Won’t ship",
  deferred:  "Set aside",
  duplicate: "Duplicate",
  resolved:  "Resolved",
};

// What a vendor may set from the dashboard/MCP. "resolved" is intentionally
// excluded — only the item's submitter can resolve it, through the widget.
export const ALLOWED_STATUSES: Status[] = [
  "open", "review", "planned", "progress", "shipped", "declined", "deferred", "duplicate",
];
const REASON_REQUIRED: Set<Status> = new Set(["declined", "deferred", "duplicate"]);

export type VendorRole = "admin" | "pm" | "viewer";

// The actor a write is performed on behalf of. For a dashboard session this is
// the logged-in user; for an API key it's the key's creator (with their live
// role). `actorWorkspaceUserId` becomes status_events.by_workspace_user_id and
// replies.workspace_user_id.
export type VendorActor = {
  workspaceId: string;
  actorWorkspaceUserId: string;
  role: VendorRole;
};

function canManage(role: VendorRole): boolean {
  return role === "admin" || role === "pm";
}

function inboundReplyAddressFor(itemShortId: string, signingSecret: string): string | null {
  const domain = process.env.CRUMB_INBOUND_DOMAIN?.trim();
  if (!domain) return null;
  return buildReplyAddress(itemShortId, signingSecret, domain);
}

// Load the workspace row + acting user once — both are needed for the event
// payload (slug, actor name), notifications, and emails. Returns null parts if
// either is missing (a revoked-then-used key, say).
async function loadActor(actor: VendorActor) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, actor.workspaceId))
    .limit(1);
  const [user] = await db
    .select({ id: workspaceUsers.id, name: workspaceUsers.name })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.id, actor.actorWorkspaceUserId))
    .limit(1);
  return { workspace: workspace ?? null, user: user ?? null };
}

// ─── status change ───────────────────────────────────────────
export async function updateItemStatus(
  actor: VendorActor,
  input: { itemShortId: string; status: Status; reason?: string; origin?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ALLOWED_STATUSES.includes(input.status)) return { ok: false, error: "bad_status" };
  const reason = input.reason?.trim() || null;
  if (REASON_REQUIRED.has(input.status) && !reason) return { ok: false, error: "reason_required" };
  // Status changes are a manage action — viewers can't.
  if (!canManage(actor.role)) return { ok: false, error: "forbidden" };

  const { workspace, user } = await loadActor(actor);
  if (!workspace || !user) return { ok: false, error: "not_found" };

  const [row] = await db
    .select({
      id: items.id,
      title: items.title,
      type: items.type,
      accountId: items.accountId,
      source: items.source,
      currentStatus: items.status,
      submitterId: accountUsers.id,
      submitterEmail: accountUsers.email,
      submitterNotifyStatus: accountUsers.notifyStatus,
      submitterUnsub: accountUsers.unsubscribedAll,
      submitterUnsubToken: accountUsers.unsubToken,
    })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };

  // No-op when status hasn't actually changed; avoids spamming the timeline
  // (and webhooks/notifications).
  if (row.currentStatus === input.status) return { ok: true };

  await db.update(items).set({ status: input.status, updatedAt: new Date() }).where(eq(items.id, row.id));
  await db.insert(statusEvents).values({
    itemId: row.id,
    fromStatus: row.currentStatus,
    toStatus: input.status,
    reason,
    byWorkspaceUserId: actor.actorWorkspaceUserId,
  });

  const origin = input.origin ?? null;

  // Fan out to registered webhook endpoints — fire-and-forget.
  void emitEvent(workspace.id, {
    type: "item.status_changed",
    workspace: workspace.slug,
    item: { short_id: input.itemShortId, title: row.title, type: row.type },
    from_status: row.currentStatus,
    to_status: input.status,
    reason,
    at: new Date().toISOString(),
  });

  // Chat cards: vendor Teams firehose + the customer's account channel.
  void notifyWorkspaceChannel(workspace.id, {
    kind: "status_change",
    shortId: input.itemShortId,
    title: row.title,
    fromStatus: row.currentStatus,
    toStatus: input.status,
    reason,
    url: origin ? `${origin}/thread/${input.itemShortId}` : null,
  });
  void notifyAccountChannels(row.accountId, {
    kind: "status_change",
    shortId: input.itemShortId,
    title: row.title,
    fromStatus: row.currentStatus,
    toStatus: input.status,
    reason,
    url: workspace.productUrl ?? null,
  }, "status");

  // Email the customer; never let a flaky provider undo a status write. Honor
  // the submitter's prefs (skip if muted or status updates are off), and only
  // auto-email widget-origin submitters — customers pulled from connectors never
  // opted into Crumb's loop (see lib/feedback/source).
  if (autoNotifiesSubmitter(row.source) && !row.submitterUnsub && row.submitterNotifyStatus) {
    try {
      const delivered = await sendStatusChangeNotification({
        to: row.submitterEmail,
        workspaceName: workspace.name,
        vendorName: user.name,
        itemShortId: input.itemShortId,
        itemTitle: row.title,
        fromStatus: row.currentStatus as Status,
        toStatus: input.status,
        reason,
        productUrl: workspace.productUrl,
        inboundReplyAddress: inboundReplyAddressFor(input.itemShortId, workspace.signingSecret),
        unsubscribeUrl: origin ? `${origin}/api/v1/unsubscribe?u=${row.submitterId}&t=${row.submitterUnsubToken}&scope=status` : null,
      });
      // Loop ledger: a status notification for a terminal status is the loop
      // actually closing — the customer heard the outcome (see Insights).
      if (delivered) {
        await db.insert(customerNotifications).values({
          itemId: row.id,
          accountUserId: row.submitterId,
          kind: "status",
          toStatus: input.status,
        });
      }
    } catch (err) {
      log.error("status notification failed", { scope: "crumb/status", err });
    }
  }

  return { ok: true };
}

// ─── vendor reply ────────────────────────────────────────────
export async function createItemReply(
  actor: VendorActor,
  input: { itemShortId: string; body: string; internal: boolean; attachmentIds?: string[]; origin?: string | null },
): Promise<{ ok: true; replyId: string } | { ok: false; error: string }> {
  const body = input.body.trim();
  const attachmentIds = (input.attachmentIds ?? []).filter(Boolean);
  // A reply can be just an attachment with no body — accept that.
  if (!body && attachmentIds.length === 0) return { ok: false, error: "empty" };

  // Viewers are read-only EXCEPT internal notes: a customer-facing reply
  // requires admin/pm. (Internal notes + @mentions stay open to all roles.)
  if (!input.internal && !canManage(actor.role)) return { ok: false, error: "forbidden" };

  const { workspace, user } = await loadActor(actor);
  if (!workspace || !user) return { ok: false, error: "not_found" };

  const [row] = await db
    .select({
      id: items.id,
      title: items.title,
      type: items.type,
      status: items.status,
      accountId: items.accountId,
      source: items.source,
      submitterId: accountUsers.id,
      submitterEmail: accountUsers.email,
      submitterNotifyReplies: accountUsers.notifyReplies,
      submitterUnsub: accountUsers.unsubscribedAll,
      submitterUnsubToken: accountUsers.unsubToken,
    })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };

  const [created] = await db.insert(replies).values({
    itemId: row.id,
    workspaceUserId: actor.actorWorkspaceUserId,
    body,
    internal: input.internal,
  }).returning({ id: replies.id });

  // Link any pending attachments the vendor uploaded. Only their own unlinked
  // rows are eligible — protects against attaching another vendor's draft.
  if (attachmentIds.length > 0 && created) {
    await db
      .update(attachments)
      .set({ replyId: created.id })
      .where(and(
        inArray(attachments.id, attachmentIds),
        isNull(attachments.replyId),
        eq(attachments.uploadedByWorkspaceUserId, actor.actorWorkspaceUserId),
      ));
  }

  await db.update(items).set({ updatedAt: new Date() }).where(eq(items.id, row.id));

  const origin = input.origin ?? null;

  // @-mentions live only on internal notes. Parse the body against teammates,
  // record matches, and notify them (excluding the author). Best-effort.
  if (input.internal && created) {
    const teammates = await db
      .select({ id: workspaceUsers.id, name: workspaceUsers.name })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.workspaceId, workspace.id));
    const mentionedIds = parseMentionIds(body, teammates).filter(id => id !== actor.actorWorkspaceUserId);
    if (mentionedIds.length > 0) {
      await db
        .insert(replyMentions)
        .values(mentionedIds.map(id => ({ replyId: created.id, workspaceUserId: id })))
        .onConflictDoNothing();
      void notifyMentioned({
        workspaceId: workspace.id,
        itemShortId: input.itemShortId,
        itemTitle: row.title,
        noteBody: body,
        byName: user.name,
        mentionedUserIds: mentionedIds,
        dashboardOrigin: origin,
      });
    }
  }

  // Webhook fan-out. Internal notes are private and filtered out at delivery.
  void emitEvent(workspace.id, {
    type: "item.reply_created",
    workspace: workspace.slug,
    item: { short_id: input.itemShortId, title: row.title, type: row.type },
    reply: { id: created!.id, internal: input.internal, author: user.name, is_customer: false },
    at: new Date().toISOString(),
  });

  // Fire the customer notification asynchronously. Don't fail the action if
  // email delivery hiccups — the reply is already in the DB. Honor the
  // submitter's prefs (skip if muted or replies are off), and only auto-email
  // widget-origin submitters (see lib/feedback/source).
  if (!input.internal && autoNotifiesSubmitter(row.source) && !row.submitterUnsub && row.submitterNotifyReplies) {
    try {
      const delivered = await sendReplyNotification({
        to: row.submitterEmail,
        workspaceName: workspace.name,
        vendorName: user.name,
        itemShortId: input.itemShortId,
        itemTitle: row.title,
        replyBody: body,
        statusLabel: STATUS_LABELS[row.status as Status],
        productUrl: workspace.productUrl,
        inboundReplyAddress: inboundReplyAddressFor(input.itemShortId, workspace.signingSecret),
        unsubscribeUrl: origin ? `${origin}/api/v1/unsubscribe?u=${row.submitterId}&t=${row.submitterUnsubToken}&scope=replies` : null,
      });
      if (delivered) {
        await db.insert(customerNotifications).values({
          itemId: row.id,
          accountUserId: row.submitterId,
          kind: "reply",
        });
      }
    } catch (err) {
      log.error("reply notification failed", { scope: "crumb/reply", err });
    }
  }

  // Customer-side chat: post the vendor reply to the account's Slack/Teams
  // channel (if connected). Internal notes excluded.
  if (!input.internal) {
    void notifyAccountChannels(row.accountId, {
      kind: "vendor_reply",
      shortId: input.itemShortId,
      title: row.title,
      vendorName: user.name,
      body,
      url: workspace.productUrl ?? null,
    }, "replies");
  }

  return { ok: true, replyId: created!.id };
}

// ─── assignment ──────────────────────────────────────────────
export async function assignItemTo(
  actor: VendorActor,
  input: { itemShortId: string; assigneeId: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!canManage(actor.role)) return { ok: false, error: "forbidden" };

  const { workspace } = await loadActor(actor);
  if (!workspace) return { ok: false, error: "not_found" };

  // The assignee must be a member of this workspace.
  let assignee: { id: string; name: string } | null = null;
  if (input.assigneeId) {
    const [member] = await db
      .select({ id: workspaceUsers.id, name: workspaceUsers.name })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.id, input.assigneeId), eq(workspaceUsers.workspaceId, workspace.id)))
      .limit(1);
    if (!member) return { ok: false, error: "not_a_member" };
    assignee = { id: member.id, name: member.name };
  }

  const [row] = await db
    .update(items)
    .set({ assigneeId: input.assigneeId, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .returning({ id: items.id, title: items.title, type: items.type });
  if (!row) return { ok: false, error: "not_found" };

  void emitEvent(workspace.id, {
    type: "item.assigned",
    workspace: workspace.slug,
    item: { short_id: input.itemShortId, title: row.title, type: row.type },
    assignee,
    at: new Date().toISOString(),
  });

  return { ok: true };
}
