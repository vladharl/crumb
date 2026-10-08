"use server";

import { db, items, accounts, accountUsers, workspaceUsers, replies, attachments } from "@crumb/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { replyConfigured } from "@/lib/ai/reply";
import { hasFeature } from "@/lib/entitlements";
import { emailConfigured } from "@/lib/email";
import { customerNotifyPlan } from "@/lib/notify/customer-plan";
import { mergedReach } from "@/lib/items/mutations";

export type ReplyDrawerMessage = {
  id: string;
  kind: "vendor" | "customer" | "system";
  authorName: string;
  authorInitials: string;
  body: string;
  createdAt: string;
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
};

// Everything the inbox reply-in-place drawer needs that the lightweight inbox
// row doesn't already carry: the customer's ARR, the recent conversation, and
// the composer's context (teammates for @-mentions, AI-draft availability,
// translation strings). Account/submitter/status are seeded from the row for
// an instant header; only this slower part streams in.
export type ReplyContext = {
  shortId: string;
  title: string;
  status: string;
  type: string;
  accountName: string;
  accountArrCents: number;
  submitterName: string;
  submitterInitials: string;
  detectedLang: string | null;
  titleTranslated: string | null;
  bodyTranslated: string | null;
  customerMessages: ReplyDrawerMessage[];
  internalMessages: ReplyDrawerMessage[];
  teammates: { id: string; name: string; initials: string }[];
  aiReplyAvailable: boolean;
  canWrite: boolean;
  // Whether a reply / status change will actually email the submitter: the
  // same plan the send paths gate on, so the drawer's copy can't drift.
  notifyPlan: ReturnType<typeof customerNotifyPlan>;
  // Customers whose requests were merged into this one that an outcome email
  // also reaches (mergedReach in lib/items/mutations).
  mergedReach: number;
};

// How many recent messages each tab shows in the drawer. The full trail lives
// one click away in the thread.
const PER_TAB = 5;

export async function getReplyContext(
  itemShortId: string,
): Promise<{ ok: true; context: ReplyContext } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();

  const [head] = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      status: items.status,
      type: items.type,
      accountName: accounts.name,
      accountArr: accounts.arrCents,
      submitterName: accountUsers.name,
      submitterInitials: accountUsers.initials,
      source: items.source,
      submitterEmail: accountUsers.email,
      submitterUnsub: accountUsers.unsubscribedAll,
      submitterNotifyReplies: accountUsers.notifyReplies,
      submitterNotifyStatus: accountUsers.notifyStatus,
      detectedLang: items.detectedLang,
      titleTranslated: items.titleTranslated,
      bodyTranslated: items.bodyTranslated,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!head) return { ok: false, error: "not_found" };

  // Last N of each side, newest-first then flipped to chronological so the
  // drawer reads top-to-bottom like the thread without shipping all history.
  const lastReplies = (internal: boolean) =>
    db.select().from(replies)
      .where(and(eq(replies.itemId, head.id), eq(replies.internal, internal)))
      .orderBy(desc(replies.createdAt))
      .limit(PER_TAB)
      .then(rows => rows.reverse());
  // Teammates name the vendor replies and fill the composer's @-mentions.
  const [wsAuthor, customerRows, internalRows, reach] = await Promise.all([
    db.select({ id: workspaceUsers.id, name: workspaceUsers.name, initials: workspaceUsers.initials })
      .from(workspaceUsers).where(eq(workspaceUsers.workspaceId, workspace.id)),
    lastReplies(false), lastReplies(true), mergedReach(workspace.id, head.id),
  ]);

  // Customers: only the ones these replies cite, as the thread does, not
  // every account user in the workspace. Attachments load alongside.
  const shown = [...customerRows, ...internalRows];
  const replyIds = shown.map(r => r.id);
  const citedIds = [...new Set(shown.flatMap(r => (r.accountUserId ? [r.accountUserId] : [])))];
  const [acctAuthor, attRows] = await Promise.all([
    citedIds.length === 0 ? [] : db
      .select({ id: accountUsers.id, name: accountUsers.name, initials: accountUsers.initials })
      .from(accountUsers)
      .where(and(eq(accountUsers.workspaceId, workspace.id), inArray(accountUsers.id, citedIds))),
    replyIds.length === 0 ? [] : db
      .select({
        id: attachments.id,
        replyId: attachments.replyId,
        filename: attachments.filename,
        contentType: attachments.contentType,
        sizeBytes: attachments.sizeBytes,
      })
      .from(attachments)
      .where(and(inArray(attachments.replyId, replyIds), isNotNull(attachments.replyId))),
  ]);
  const wsById = Object.fromEntries(wsAuthor.map(u => [u.id, u]));
  const acctById = Object.fromEntries(acctAuthor.map(u => [u.id, u]));
  const attByReply = new Map<string, typeof attRows>();
  for (const a of attRows) {
    if (!a.replyId) continue;
    const arr = attByReply.get(a.replyId) ?? [];
    arr.push(a);
    attByReply.set(a.replyId, arr);
  }

  const mapMsg = (r: typeof customerRows[number]): ReplyDrawerMessage => {
    const atts = (attByReply.get(r.id) ?? []).map(a => ({
      id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes,
    }));
    const createdAt = r.createdAt.toISOString();
    if (r.workspaceUserId && wsById[r.workspaceUserId]) {
      const u = wsById[r.workspaceUserId]!;
      return { id: r.id, kind: "vendor", authorName: u.name, authorInitials: u.initials, body: r.body, createdAt, attachments: atts };
    }
    if (r.accountUserId && acctById[r.accountUserId]) {
      const u = acctById[r.accountUserId]!;
      return { id: r.id, kind: "customer", authorName: u.name, authorInitials: u.initials, body: r.body, createdAt, attachments: atts };
    }
    return { id: r.id, kind: "system", authorName: "—", authorInitials: "·", body: r.body, createdAt, attachments: atts };
  };

  return {
    ok: true,
    context: {
      shortId: head.shortId,
      title: head.title,
      status: head.status,
      type: head.type,
      accountName: head.accountName,
      accountArrCents: head.accountArr,
      submitterName: head.submitterName,
      submitterInitials: head.submitterInitials,
      detectedLang: head.detectedLang,
      titleTranslated: head.titleTranslated,
      bodyTranslated: head.bodyTranslated,
      customerMessages: customerRows.map(mapMsg),
      internalMessages: internalRows.map(mapMsg),
      teammates: wsAuthor,
      aiReplyAvailable: replyConfigured() && hasFeature(workspace, "ai"),
      canWrite: user.role === "admin" || user.role === "pm",
      notifyPlan: customerNotifyPlan({
        source: head.source,
        submitterEmail: head.submitterEmail,
        unsubscribedAll: head.submitterUnsub,
        notifyReplies: head.submitterNotifyReplies,
        notifyStatus: head.submitterNotifyStatus,
        emailConfigured: emailConfigured(),
      }),
      mergedReach: reach,
    },
  };
}
