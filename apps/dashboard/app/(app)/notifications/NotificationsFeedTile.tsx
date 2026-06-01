import Link from "next/link";
import { Card, CardHead, Ic, Pill } from "@crumb/ui";
import { ageFrom, getActiveSession } from "@/lib/server";
import { loadFeed, type FeedFilter } from "@/lib/notifications-feed";
import { MarkAllReadButton } from "./MarkAllReadButton";

export type { FeedFilter };

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
