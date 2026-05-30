import Link from "next/link";
import { Card, CardHead, Ic, Pill } from "@crumb/ui";
import { db, items, accounts, accountUsers, workspaceUsers, replies, replyMentions } from "@crumb/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ageFrom, getActiveSession } from "@/lib/server";
import { MarkAllReadButton } from "./MarkAllReadButton";

export type FeedFilter = "all" | "unread" | "mentions";

type FeedEntry = {
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

async function loadFeed(workspaceId: string, userId: string, lastReadAt: Date | null): Promise<FeedEntry[]> {
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

export async function NotificationsFeedTile({ filter = "all" }: { filter?: FeedFilter }) {
  const { workspace, user } = await getActiveSession();
  const feed = await loadFeed(workspace.id, user.id, user.notificationsLastReadAt ?? null);
  const unread = feed.filter(e => e.unread).length;
  const mentions = feed.filter(e => e.mentioned).length;
  const shown = filter === "unread" ? feed.filter(e => e.unread)
    : filter === "mentions" ? feed.filter(e => e.mentioned)
    : feed;

  const emptyCopy = filter === "mentions"
    ? "No mentions yet. When a teammate @-mentions you in an internal note, it shows up here."
    : filter === "unread"
      ? "You're all caught up."
      : <>Nothing in the last while. Drop something from the widget at <Link href="/widget-demo.html" target="_blank">/widget-demo.html</Link> and reload.</>;

  return (
    <Card>
      <CardHead title={`In-app · ${feed.length} recent`} after={
        <div className="row gap-2 center">
          <MarkAllReadButton disabled={unread === 0} />
          <div className="seg">
            <Link href="/notifications" aria-selected={filter === "all"}>All</Link>
            <Link href="/notifications?filter=unread" aria-selected={filter === "unread"}>Unread · {unread}</Link>
            <Link href="/notifications?filter=mentions" aria-selected={filter === "mentions"}>Mentions · {mentions}</Link>
          </div>
        </div>
      } />
      <div className="list">
        {shown.length === 0 && (
          <div className="card-body">
            <p className="text-sm muted" style={{ margin: 0 }}>{emptyCopy}</p>
          </div>
        )}
        {shown.map(e => (
          <Link
            key={e.id}
            href={e.href}
            className="list-row"
            style={{ gridTemplateColumns: "1fr 60px 12px", padding: "14px 18px" }}
          >
            <div className="col gap-1 grow truncate">
              <span className="text-sm truncate" style={{ display: "block" }}>
                <span className={e.unread ? "fw-med" : "muted"}>{e.who}</span>
                {e.whoSub && <span className="muted"> · {e.whoSub}</span>}
                <span className={e.mentioned ? "" : "muted"} style={e.mentioned ? { color: "var(--accent)", fontWeight: 500 } : undefined}> {e.what} </span>
                <span className={e.unread ? "" : "muted"}>{e.item}</span>
                {e.internal && <Pill style={{ marginLeft: 6 }}><Ic.lock style={{ width: 9, height: 9 }} />Internal</Pill>}
              </span>
              <span className="text-xs muted mono">{e.shortId}</span>
            </div>
            <span className="text-xs muted mono" style={{ textAlign: "right" }}>{ageFrom(e.at)}</span>
            <span>{e.unread && <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--ink)", display: "inline-block" }} />}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
