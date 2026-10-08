import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db, items, replies, replyMentions, attachments, statusEvents,
  accountUsers, workspaceUsers, workspaces, customerNotifications,
} from "@crumb/db";
import { statusLabel, REASON_REQUIRED, VENDOR_STATUSES, type Status } from "@crumb/ui";
import { emitEvent } from "@/lib/webhooks";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { notifyAccountChannels } from "@/lib/notify/account-channel";
import { customerNotifyPlan, statusEmailsCustomer, type NotifyPlan } from "@/lib/notify/customer-plan";
import { emailConfigured, sendReplyNotification, sendStatusChangeNotification } from "@/lib/email";
import { notifyMentioned, parseMentionIds } from "@/lib/mention-notify";
import { buildReplyAddress } from "@/lib/reply-token";
import { hostedThreadPath } from "@/lib/hosted-thread";
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

// The status union + labels live once, in @crumb/ui.
export type { Status };

// What a vendor may set from the dashboard/MCP. "resolved" is intentionally
// excluded — only the item's submitter can resolve it, through the widget.
export const ALLOWED_STATUSES: Status[] = [...VENDOR_STATUSES];

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

// The item plus its submitter's address + email prefs, scoped to the workspace.
async function loadItem(workspaceId: string, itemShortId: string) {
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
      submitterNotifyStatus: accountUsers.notifyStatus,
      submitterUnsub: accountUsers.unsubscribedAll,
      submitterUnsubToken: accountUsers.unsubToken,
    })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(and(eq(items.workspaceId, workspaceId), eq(items.shortId, itemShortId)))
    .limit(1);
  return row ?? null;
}

// The same plan the thread renders its "will be emailed" copy from.
function notifyPlanFor(row: NonNullable<Awaited<ReturnType<typeof loadItem>>>) {
  return customerNotifyPlan({
    source: row.source,
    submitterEmail: row.submitterEmail,
    unsubscribedAll: row.submitterUnsub,
    notifyReplies: row.submitterNotifyReplies,
    notifyStatus: row.submitterNotifyStatus,
    emailConfigured: emailConfigured(),
  });
}

// Whether to call the sender. "not_configured" still calls it so the stdout
// provider prints the email in dev; the sender reports that as not delivered,
// so no ledger row is written and `emailed` stays false.
function shouldSend(plan: NotifyPlan): boolean {
  return plan.willEmail || plan.reason === "not_configured";
}

// ─── status change ───────────────────────────────────────────
// `emailed` is true only when a real provider accepted the customer email (the
// same fact the loop ledger records). The customer is emailed only for
// outcomes (statusEmailsCustomer); every change still writes status_events and
// fires webhooks + chat cards. `opts` is internal (reply-and-close): it can
// suppress this core's email or put a message in it in place of the reason.
export async function updateItemStatus(
  actor: VendorActor,
  input: { itemShortId: string; status: Status; reason?: string; origin?: string | null },
  opts: { customerEmail?: boolean; customerMessage?: string } = {},
): Promise<{ ok: true; emailed: boolean } | { ok: false; error: string }> {
  if (!ALLOWED_STATUSES.includes(input.status)) return { ok: false, error: "bad_status" };
  const reason = input.reason?.trim() || null;
  if (REASON_REQUIRED.has(input.status) && !reason) return { ok: false, error: "reason_required" };
  // Status changes are a manage action — viewers can't.
  if (!canManage(actor.role)) return { ok: false, error: "forbidden" };

  const { workspace, user } = await loadActor(actor);
  if (!workspace || !user) return { ok: false, error: "not_found" };

  const row = await loadItem(workspace.id, input.itemShortId);
  if (!row) return { ok: false, error: "not_found" };
  const fromStatus = row.status;

  // No-op when status hasn't actually changed; avoids spamming the timeline
  // (and webhooks/notifications).
  if (fromStatus === input.status) return { ok: true, emailed: false };

  await db.update(items).set({ status: input.status, updatedAt: new Date() }).where(eq(items.id, row.id));
  await db.insert(statusEvents).values({
    itemId: row.id,
    fromStatus,
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
    from_status: fromStatus,
    to_status: input.status,
    reason,
    at: new Date().toISOString(),
  });

  // Chat cards: vendor Teams firehose + the customer's account channel.
  void notifyWorkspaceChannel(workspace.id, {
    kind: "status_change",
    shortId: input.itemShortId,
    title: row.title,
    fromStatus,
    toStatus: input.status,
    reason,
    url: origin ? `${origin}/thread/${input.itemShortId}` : null,
  });
  void notifyAccountChannels(row.accountId, {
    kind: "status_change",
    shortId: input.itemShortId,
    title: row.title,
    fromStatus,
    toStatus: input.status,
    reason,
    url: workspace.productUrl ?? null,
  }, "status");

  // Email the customer; never let a flaky provider undo a status write. Who
  // may be emailed (widget-origin, has an address, not muted) is the shared
  // plan; which statuses are worth an email is statusEmailsCustomer.
  let emailed = false;
  if (opts.customerEmail !== false && statusEmailsCustomer(input.status) && shouldSend(notifyPlanFor(row).status)) {
    try {
      emailed = await sendStatusChangeNotification({
        to: row.submitterEmail,
        workspaceName: workspace.name,
        vendorName: user.name,
        itemShortId: input.itemShortId,
        itemTitle: row.title,
        fromStatus,
        toStatus: input.status,
        reason: opts.customerMessage || reason,
        productUrl: workspace.productUrl,
        viewUrl: origin ? origin + hostedThreadPath(input.itemShortId, workspace.signingSecret) : null,
        accent: workspace.accent,
        inboundReplyAddress: inboundReplyAddressFor(input.itemShortId, workspace.signingSecret),
        unsubscribeUrl: origin ? `${origin}/api/v1/unsubscribe?u=${row.submitterId}&t=${row.submitterUnsubToken}&scope=status` : null,
      });
      // Loop ledger: a status notification for a terminal status is the loop
      // actually closing — the customer heard the outcome (see Insights).
      if (emailed) {
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

  return { ok: true, emailed };
}

// ─── vendor reply ────────────────────────────────────────────
// `emailed`: as for updateItemStatus. `opts` is internal (reply-and-close): it
// can suppress this core's email, or show the status the item is moving to.
export async function createItemReply(
  actor: VendorActor,
  input: { itemShortId: string; body: string; internal: boolean; attachmentIds?: string[]; origin?: string | null },
  opts: { customerEmail?: boolean; shownStatus?: string } = {},
): Promise<{ ok: true; replyId: string; emailed: boolean } | { ok: false; error: string }> {
  const body = input.body.trim();
  const attachmentIds = (input.attachmentIds ?? []).filter(Boolean);
  // A reply can be just an attachment with no body — accept that.
  if (!body && attachmentIds.length === 0) return { ok: false, error: "empty" };

  // Viewers are read-only EXCEPT internal notes: a customer-facing reply
  // requires admin/pm. (Internal notes + @mentions stay open to all roles.)
  if (!input.internal && !canManage(actor.role)) return { ok: false, error: "forbidden" };

  const { workspace, user } = await loadActor(actor);
  if (!workspace || !user) return { ok: false, error: "not_found" };

  const row = await loadItem(workspace.id, input.itemShortId);
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

  // Email the customer. Don't fail the action if delivery hiccups — the reply
  // is already in the DB. Who may be emailed is the shared plan (widget-origin,
  // has an address, replies not muted).
  let emailed = false;
  if (!input.internal && opts.customerEmail !== false && shouldSend(notifyPlanFor(row).replies)) {
    try {
      emailed = await sendReplyNotification({
        to: row.submitterEmail,
        workspaceName: workspace.name,
        vendorName: user.name,
        itemShortId: input.itemShortId,
        itemTitle: row.title,
        replyBody: body,
        statusLabel: statusLabel(opts.shownStatus ?? row.status),
        productUrl: workspace.productUrl,
        viewUrl: origin ? origin + hostedThreadPath(input.itemShortId, workspace.signingSecret) : null,
        accent: workspace.accent,
        inboundReplyAddress: inboundReplyAddressFor(input.itemShortId, workspace.signingSecret),
        unsubscribeUrl: origin ? `${origin}/api/v1/unsubscribe?u=${row.submitterId}&t=${row.submitterUnsubToken}&scope=replies` : null,
      });
      if (emailed) {
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

  return { ok: true, replyId: created!.id, emailed };
}

// ─── reply and close ─────────────────────────────────────────
// Post a customer-facing reply and set the outcome in one go, with ONE email:
// the status email carrying the reply as its message. When that email won't go
// out (the status didn't move, or the customer turned status emails off), the
// reply core sends its usual reply email instead, under the reply prefs. For
// "declined" the reply doubles as the required reason.
export async function replyAndSetItemStatus(
  actor: VendorActor,
  input: { itemShortId: string; body: string; status: "shipped" | "declined"; attachmentIds?: string[]; origin?: string | null },
): Promise<{ ok: true; replyId: string; emailed: boolean } | { ok: false; error: string }> {
  if (input.status !== "shipped" && input.status !== "declined") return { ok: false, error: "bad_status" };
  const body = input.body.trim();
  if (input.status === "declined" && !body) return { ok: false, error: "reason_required" };
  // A manage action, like both cores below.
  if (!canManage(actor.role)) return { ok: false, error: "forbidden" };

  const row = await loadItem(actor.workspaceId, input.itemShortId);
  if (!row) return { ok: false, error: "not_found" };
  const combined = row.status !== input.status && shouldSend(notifyPlanFor(row).status);

  const reply = await createItemReply(
    actor,
    { itemShortId: input.itemShortId, body, internal: false, attachmentIds: input.attachmentIds, origin: input.origin },
    { customerEmail: !combined, shownStatus: input.status },
  );
  if (!reply.ok) return reply;
  const moved = await updateItemStatus(
    actor,
    { itemShortId: input.itemShortId, status: input.status, reason: input.status === "declined" ? body : undefined, origin: input.origin },
    { customerEmail: combined, customerMessage: body },
  );
  if (!moved.ok) return moved;

  return { ok: true, replyId: reply.replyId, emailed: reply.emailed || moved.emailed };
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
