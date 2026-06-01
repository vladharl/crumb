import "server-only";
import { db, items, accounts, accountUsers, workspaceUsers, replies, replyMentions } from "@crumb/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

// Shared notifications feed loader. Lifted out of NotificationsFeedTile so both
// the in-app feed surfaces (the top-bar bell popover and the settings digest)
// read from one source of truth. Plain Drizzle — safe in both editions.

export type FeedFilter = "all" | "unread" | "mentions";

export type FeedEntry = {
  id: string;
  shortId: string;
  href: string;
  who: string;
  whoSub: string;
  what: string;
  item: string;
  at: Date;
  unread: boolean;
  internal: boolean;
  mentioned: boolean;
};

export async function loadFeed(workspaceId: string, userId: string, lastReadAt: Date | null): Promise<FeedEntry[]> {
  const newItems = await db
    .select({
      kind: sql<"item">`'item'::text`,
      itemId: items.id,
      shortId: items.shortId,
      title: items.title,
      at: items.createdAt,
      accountName: accounts.name,
      authorName: accountUsers.name,
      internal: sql<boolean>`false`,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(items.createdAt))
    .limit(40);

  const newReplies = await db
    .select({
      kind: sql<"reply">`'reply'::text`,
      replyId: replies.id,
      itemId: items.id,
      shortId: items.shortId,
      title: items.title,
      at: replies.createdAt,
      accountName: accounts.name,
      vendorName: workspaceUsers.name,
      customerName: accountUsers.name,
      internal: replies.internal,
    })
    .from(replies)
    .innerJoin(items, eq(items.id, replies.itemId))
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, replies.workspaceUserId))
    .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(replies.createdAt))
    .limit(40);

  // Which of these replies @-mention the current user? Powers the Mentions
  // filter + flips internal notes that tag you to "unread".
  const replyIds = newReplies.map(r => r.replyId);
  const mentionRows = replyIds.length === 0 ? [] : await db
    .select({ replyId: replyMentions.replyId })
    .from(replyMentions)
    .where(and(inArray(replyMentions.replyId, replyIds), eq(replyMentions.workspaceUserId, userId)));
  const mentionedReplyIds = new Set(mentionRows.map(m => m.replyId));

  const watermark = lastReadAt?.getTime() ?? 0;
  const entries: FeedEntry[] = [];
  for (const r of newItems) {
    entries.push({
      id: `i:${r.itemId}`,
      shortId: r.shortId,
      href: `/thread/${r.shortId}`,
      who: r.authorName,
      whoSub: r.accountName,
      what: "submitted",
      item: r.title,
      at: r.at,
      unread: r.at.getTime() > watermark,
      internal: false,
      mentioned: false,
    });
  }
  for (const r of newReplies) {
    const who = r.vendorName ?? r.customerName ?? "Someone";
    const sub = r.vendorName ? "vendor" : (r.customerName ? r.accountName : "system");
    const mentioned = mentionedReplyIds.has(r.replyId);
    entries.push({
      id: `r:${r.itemId}:${r.at.getTime()}`,
      shortId: r.shortId,
      href: `/thread/${r.shortId}`,
      who,
      whoSub: sub,
      what: mentioned ? "mentioned you on" : r.internal ? "noted internally on" : "replied on",
      item: r.title,
      at: r.at,
      // A mention of you counts as unread even though it's an internal note.
      unread: (mentioned || !r.internal) && r.at.getTime() > watermark,
      internal: r.internal,
      mentioned,
    });
  }
  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  return entries.slice(0, 30);
}
