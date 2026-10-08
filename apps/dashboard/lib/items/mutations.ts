import "server-only";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db, items, replies, replyMentions, attachments, statusEvents,
  accounts, accountUsers, workspaceUsers, workspaces, customerNotifications, type Workspace,
} from "@crumb/db";
import { statusLabel, CLOSED_STATUSES, REASON_REQUIRED, VENDOR_STATUSES, type Status } from "@crumb/ui";
import { emitEvent } from "@/lib/webhooks";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { notifyAccountChannels } from "@/lib/notify/account-channel";
import { customerNotifyPlan, statusEmailsCustomer, type NotifyPlan } from "@/lib/notify/customer-plan";
import { emailConfigured, sendReplyNotification, sendStatusChangeNotification } from "@/lib/email";
import { notifyMentioned, parseMentionIds } from "@/lib/mention-notify";
import { notifyAssigned } from "@/lib/vendor-notify";
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

// Items plus their account name and their submitter's address + email prefs.
// A fresh query each call; the caller adds the WHERE.
function selectItemsWithSubmitter() {
  return db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      status: items.status,
      mergedIntoId: items.mergedIntoId,
      accountId: items.accountId,
      accountName: accounts.name,
      source: items.source,
      submitterId: accountUsers.id,
      submitterName: accountUsers.name,
      submitterEmail: accountUsers.email,
      submitterNotifyReplies: accountUsers.notifyReplies,
      submitterNotifyStatus: accountUsers.notifyStatus,
      submitterUnsub: accountUsers.unsubscribedAll,
      submitterUnsubToken: accountUsers.unsubToken,
    })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .innerJoin(accounts, eq(accounts.id, items.accountId));
}

// One item, scoped to the workspace.
async function loadItem(workspaceId: string, itemShortId: string) {
  const [row] = await selectItemsWithSubmitter()
    .where(and(eq(items.workspaceId, workspaceId), eq(items.shortId, itemShortId)))
    .limit(1);
  return row ?? null;
}

type ItemRow = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

// The same plan the thread renders its "will be emailed" copy from.
function notifyPlanFor(row: ItemRow) {
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

// One status email about `row` itself: its title, short id, links and its
// submitter's unsubscribe link. True only when a real provider accepted it,
// which is when the loop ledger gets its row and customer.notified fires.
// Never throws, so a flaky provider can't undo the write that led here.
async function emailStatus(
  workspace: Workspace,
  vendorName: string,
  row: ItemRow,
  m: { fromStatus: string | null; toStatus: string; reason: string | null; origin: string | null },
): Promise<boolean> {
  let delivered = false;
  try {
    delivered = await sendStatusChangeNotification({
      to: row.submitterEmail,
      workspaceName: workspace.name,
      vendorName,
      itemShortId: row.shortId,
      itemTitle: row.title,
      fromStatus: m.fromStatus,
      toStatus: m.toStatus,
      reason: m.reason,
      productUrl: workspace.productUrl,
      viewUrl: m.origin ? m.origin + hostedThreadPath(row.shortId, workspace.signingSecret) : null,
      accent: workspace.accent,
      inboundReplyAddress: inboundReplyAddressFor(row.shortId, workspace.signingSecret),
      unsubscribeUrl: m.origin ? `${m.origin}/api/v1/unsubscribe?u=${row.submitterId}&t=${row.submitterUnsubToken}&scope=status` : null,
    });
    // Loop ledger: a status notification for a terminal status is the loop
    // actually closing — the customer heard the outcome (see Insights).
    if (delivered) {
      await db.insert(customerNotifications).values({
        itemId: row.id,
        accountUserId: row.submitterId,
        kind: "status",
        toStatus: m.toStatus,
      });
      void emitEvent(workspace.id, {
        type: "customer.notified",
        workspace: workspace.slug,
        item: { short_id: row.shortId, title: row.title, type: row.type },
        notification: { kind: "status", channel: "email", to_status: m.toStatus },
        at: new Date().toISOString(),
      });
    }
  } catch (err) {
    log.error("status notification failed", { scope: "crumb/status", err });
  }
  return delivered;
}

const addressOf = (email: string) => email.trim().toLowerCase();

// The requests merged into `itemId` that still follow it: those reading
// Duplicate. One a teammate moved on its own (its thread, the bulk bar) has its
// own status, and got its own email for it.
const followersOf = (itemId: string) => and(eq(items.mergedIntoId, itemId), eq(items.status, "duplicate"));

// Whether moving a merged request to `status` would only repeat what its
// canonical's fan-out last told its customer. An email that carries a reason
// or a message of its own still goes.
async function repeatsFanOut(row: ItemRow, status: string, message: string | null): Promise<boolean> {
  if (!row.mergedIntoId || message) return false;
  const [last] = await db
    .select({ toStatus: customerNotifications.toStatus })
    .from(customerNotifications)
    .where(and(eq(customerNotifications.itemId, row.id), eq(customerNotifications.kind, "status")))
    .orderBy(desc(customerNotifications.sentAt))
    .limit(1);
  return last?.toStatus === status;
}

// ─── status change ───────────────────────────────────────────
// `emailed` is true only when a real provider accepted the customer email (the
// same fact the loop ledger records); `mergedEmailed` counts the customers
// whose requests were merged into this one who got theirs. The customer is
// emailed, and their account channels carded, only for outcomes
// (statusEmailsCustomer); every change still writes status_events and fires
// webhooks and the team's chat card. `opts` is internal:
// reply-and-close can suppress this core's email or put a message in it in
// place of the reason, and the changelog passes `alreadyTold`, the (lowercased)
// addresses its announcement reached, so none of them gets a second email.
export async function updateItemStatus(
  actor: VendorActor,
  input: { itemShortId: string; status: Status; reason?: string; origin?: string | null },
  opts: { customerEmail?: boolean; customerMessage?: string; alreadyTold?: ReadonlySet<string> } = {},
): Promise<{ ok: true; emailed: boolean; mergedEmailed: number } | { ok: false; error: string }> {
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
  if (fromStatus === input.status) return { ok: true, emailed: false, mergedEmailed: 0 };

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

  // Chat cards: the vendor's Teams firehose hears every move; the customer's
  // own account channels hear the same statuses their email does, never triage.
  void notifyWorkspaceChannel(workspace.id, {
    kind: "status_change",
    shortId: input.itemShortId,
    title: row.title,
    fromStatus,
    toStatus: input.status,
    reason,
    url: origin ? `${origin}/thread/${input.itemShortId}` : null,
  });
  if (statusEmailsCustomer(input.status)) {
    void notifyAccountChannels(row.accountId, {
      kind: "status_change",
      shortId: input.itemShortId,
      title: row.title,
      fromStatus,
      toStatus: input.status,
      reason,
      url: workspace.productUrl ?? null,
    }, "status");
  }

  // Email the customer; never let a flaky provider undo a status write. Who
  // may be emailed (widget-origin, has an address, not muted) is the shared
  // plan; which statuses are worth an email is statusEmailsCustomer.
  let emailed = false;
  let mergedEmailed = 0;
  const toldElsewhere = (r: ItemRow) => !!opts.alreadyTold?.has(addressOf(r.submitterEmail));
  if (statusEmailsCustomer(input.status)) {
    const message = opts.customerMessage || reason;
    if (
      opts.customerEmail !== false && !toldElsewhere(row) && shouldSend(notifyPlanFor(row).status)
      && !(await repeatsFanOut(row, input.status, message))
    ) {
      emailed = await emailStatus(workspace, user.name, row, {
        fromStatus, toStatus: input.status, reason: message, origin,
      });
    }
    // Customers whose requests were merged into this one and still follow it
    // hear it too, each about their own item (its status reads Duplicate, hence
    // no "from") under their own plan, and once per person: whoever was just
    // told is skipped. They get the status and its standard wording, never the
    // typed reason or a reply-and-close message: those were written while
    // looking at this item's customer and can name them or their account.
    // mergedReach (below) previews this set.
    // ponytail: sequential sends in the request; move them to the sweep cron
    // if canonicals start gathering dozens of widget duplicates.
    const told = new Set(emailed ? [row.submitterId] : []);
    const merged = await selectItemsWithSubmitter()
      .where(and(eq(items.workspaceId, workspace.id), followersOf(row.id)));
    for (const dup of merged) {
      if (told.has(dup.submitterId) || toldElsewhere(dup) || !shouldSend(notifyPlanFor(dup).status)) continue;
      if (await emailStatus(workspace, user.name, dup, {
        fromStatus: null, toStatus: input.status, reason: null, origin,
      })) {
        told.add(dup.submitterId);
        mergedEmailed++;
      }
    }
  }

  return { ok: true, emailed, mergedEmailed };
}

// How many more customers an outcome email on this item reaches: the people
// whose requests were merged into it (and still follow it) and whose own plan
// emails them, each once, besides its own submitter when they're emailed. The
// same set updateItemStatus's fan-out sends to, so the status controls can say
// who gets the email (and the reason) before the vendor commits.
export async function mergedReach(workspaceId: string, itemId: string): Promise<number> {
  const group = await selectItemsWithSubmitter()
    .where(and(eq(items.workspaceId, workspaceId), or(eq(items.id, itemId), followersOf(itemId))));
  const head = group.find(r => r.id === itemId);
  const reached = new Set(group.filter(r => r !== head && notifyPlanFor(r).status.willEmail).map(r => r.submitterId));
  if (head && notifyPlanFor(head).status.willEmail) reached.delete(head.submitterId);
  return reached.size;
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
  // has an address, replies not muted). Only this item's submitter: unlike
  // status changes, a reply never fans out to requests merged into this one,
  // because it is written to this customer and can carry their details.
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
        void emitEvent(workspace.id, {
          type: "customer.notified",
          workspace: workspace.slug,
          item: { short_id: input.itemShortId, title: row.title, type: row.type },
          notification: { kind: "reply", channel: "email", to_status: null },
          at: new Date().toISOString(),
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
// "declined" the reply doubles as the required reason. `mergedEmailed` is
// updateItemStatus's: the merged requesters told the outcome (without the reply).
export async function replyAndSetItemStatus(
  actor: VendorActor,
  input: { itemShortId: string; body: string; status: "shipped" | "declined"; attachmentIds?: string[]; origin?: string | null },
): Promise<{ ok: true; replyId: string; emailed: boolean; mergedEmailed: number } | { ok: false; error: string }> {
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

  return { ok: true, replyId: reply.replyId, emailed: reply.emailed || moved.emailed, mergedEmailed: moved.mergedEmailed };
}

// ─── assignment ──────────────────────────────────────────────
// `notify: false` skips the assignee's alert: the inbox bulk bar sends one
// summary per assignee instead, and its Undo sends none.
export async function assignItemTo(
  actor: VendorActor,
  input: { itemShortId: string; assigneeId: string | null },
  opts: { notify?: boolean } = {},
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

  const where = and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId));
  const [before] = await db.select({ assigneeId: items.assigneeId }).from(items).where(where).limit(1);
  if (!before) return { ok: false, error: "not_found" };
  // Nothing changed: no write, no item.assigned, no alert, whoever called.
  if (before.assigneeId === input.assigneeId) return { ok: true };
  const [row] = await db
    .update(items)
    .set({ assigneeId: input.assigneeId, updatedAt: new Date() })
    .where(where)
    .returning({ id: items.id, title: items.title, type: items.type });
  if (!row) return { ok: false, error: "not_found" };

  void emitEvent(workspace.id, {
    type: "item.assigned",
    workspace: workspace.slug,
    item: { short_id: input.itemShortId, title: row.title, type: row.type },
    assignee,
    at: new Date().toISOString(),
  });

  // Tell the new assignee, unless they took it themselves.
  if (opts.notify !== false && input.assigneeId && input.assigneeId !== actor.actorWorkspaceUserId) {
    void notifyAssigned({
      workspaceId: workspace.id,
      itemId: row.id,
      assigneeId: input.assigneeId,
      actorWorkspaceUserId: actor.actorWorkspaceUserId,
    });
  }

  return { ok: true };
}

// ─── merge notice ────────────────────────────────────────────
// The one email a customer gets when their request is merged into another
// (thread actions mergeItems). It is about their own item, never the
// canonical's title, account or words; from then on they hear the canonical's
// status changes through updateItemStatus. Same plan and ledger as any status
// email. True only when a real provider accepted it. Only an open canonical
// will move again, so only its notice promises news; a closed one says how it
// ended. Never "an earlier request": a vendor can merge an older one into a
// newer one.
export function mergeNoticeText(canonicalStatus: string | null): string {
  const combined = "We've combined this with another request for the same thing.";
  if (canonicalStatus === "shipped") return `${combined} It's already live.`;
  if (canonicalStatus === "declined") return `${combined} We've decided not to take it on.`;
  if (CLOSED_STATUSES.has(canonicalStatus ?? "")) return combined;
  return "We've combined this with a request we're already tracking. You'll hear from us here when it moves.";
}

export async function notifyMergedItem(
  actor: VendorActor,
  input: { itemShortId: string; origin?: string | null },
): Promise<boolean> {
  if (!canManage(actor.role)) return false;
  const { workspace, user } = await loadActor(actor);
  if (!workspace || !user) return false;
  const row = await loadItem(workspace.id, input.itemShortId);
  if (!row || !shouldSend(notifyPlanFor(row).status)) return false;
  const [canonical] = row.mergedIntoId
    ? await db.select({ status: items.status }).from(items).where(eq(items.id, row.mergedIntoId)).limit(1)
    : [];
  return emailStatus(workspace, user.name, row, {
    fromStatus: null, toStatus: "duplicate", reason: mergeNoticeText(canonical?.status ?? null), origin: input.origin ?? null,
  });
}

// Who that email would reach and whether it goes out, from the same plan, so
// the vendor sees it before confirming a merge (MergePanel).
export async function mergeNoticePlan(workspaceId: string, itemShortId: string) {
  const row = await loadItem(workspaceId, itemShortId);
  return row && { name: row.submitterName, accountName: row.accountName, source: row.source, plan: notifyPlanFor(row).status };
}
