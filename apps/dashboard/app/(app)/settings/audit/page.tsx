import Link from "next/link";
import { Card, CardHead, Ic, Pill, statusLabel } from "@crumb/ui";
import {
  db, items, replies, statusEvents, workspaceUsers, accountUsers,
} from "@crumb/db";
import { desc, eq } from "drizzle-orm";
import { ageFrom, getActiveSession } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log · Settings" };

type FeedEntry = {
  id: string;
  kind: "status" | "reply" | "internal_note";
  at: Date;
  shortId: string;
  itemTitle: string;
  actorName: string | null;
  summary: string;
  reason?: string | null;
};

async function loadFeed(workspaceId: string): Promise<FeedEntry[]> {
  const statusRows = await db
    .select({
      id: statusEvents.id,
      at: statusEvents.at,
      fromStatus: statusEvents.fromStatus,
      toStatus: statusEvents.toStatus,
      reason: statusEvents.reason,
      shortId: items.shortId,
      itemTitle: items.title,
      actorName: workspaceUsers.name,
    })
    .from(statusEvents)
    .innerJoin(items, eq(items.id, statusEvents.itemId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, statusEvents.byWorkspaceUserId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(statusEvents.at))
    .limit(40);

  const replyRows = await db
    .select({
      id: replies.id,
      at: replies.createdAt,
      internal: replies.internal,
      body: replies.body,
      shortId: items.shortId,
      itemTitle: items.title,
      vendorName: workspaceUsers.name,
      customerName: accountUsers.name,
    })
    .from(replies)
    .innerJoin(items, eq(items.id, replies.itemId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, replies.workspaceUserId))
    .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(replies.createdAt))
    .limit(40);

  const entries: FeedEntry[] = [];

  for (const r of statusRows) {
    const fromLabel = r.fromStatus ? statusLabel(r.fromStatus) : null;
    const toLabel = statusLabel(r.toStatus);
    entries.push({
      id: `s:${r.id}`,
      kind: "status",
      at: r.at,
      shortId: r.shortId,
      itemTitle: r.itemTitle,
      actorName: r.actorName,
      summary: fromLabel ? `${fromLabel} → ${toLabel}` : `Submitted as ${toLabel}`,
      reason: r.reason,
    });
  }
  for (const r of replyRows) {
    entries.push({
      id: `r:${r.id}`,
      kind: r.internal ? "internal_note" : "reply",
      at: r.at,
      shortId: r.shortId,
      itemTitle: r.itemTitle,
      actorName: r.vendorName ?? r.customerName,
      summary: r.body.length > 90 ? r.body.slice(0, 89) + "…" : r.body,
    });
  }

  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  return entries.slice(0, 50);
}

export default async function AuditPage() {
  const { workspace, user } = await getActiveSession();
  const isAdmin = user.role === "admin";

  const feed = isAdmin ? await loadFeed(workspace.id) : [];

  return (
    <>
      <Card>
        <CardHead title={`Audit log · last ${feed.length}`} after={<Pill>workspace-wide</Pill>} />
        <div className="card-body col gap-3" style={{ padding: 0 }}>
          {!isAdmin ? (
            <div style={{ padding: "16px 18px" }}>
              <p className="text-sm muted" style={{ margin: 0 }}>Only admins can read the audit log.</p>
            </div>
          ) : feed.length === 0 ? (
            <div style={{ padding: "16px 18px" }}>
              <p className="text-sm muted" style={{ margin: 0 }}>
                Nothing logged yet. Status changes, replies, and notes will land here as they happen.
              </p>
            </div>
          ) : (
            <div className="list">
              {feed.map(e => (
                <Link
                  key={e.id}
                  href={`/thread/${e.shortId}`}
                  className="list-row"
                  style={{
                    gridTemplateColumns: "100px 90px 1fr 56px",
                    padding: "10px 18px",
                  }}
                >
                  <span className="text-2xs mono muted">{e.shortId}</span>
                  <span>
                    {e.kind === "status"
                      ? <Pill>status</Pill>
                      : e.kind === "internal_note"
                        ? <Pill><Ic.lock style={{ width: 9, height: 9 }} />note</Pill>
                        : <Pill>reply</Pill>}
                  </span>
                  <div className="col gap-1 grow truncate">
                    <span className="text-sm truncate" style={{ display: "block" }}>
                      <span className="fw-med">{e.actorName ?? "—"}</span>
                      <span className="muted"> · </span>
                      <span>{e.summary}</span>
                    </span>
                    {e.reason && (
                      <span className="text-xs muted" style={{ display: "block", lineHeight: 1.45 }}>
                        “{e.reason}”
                      </span>
                    )}
                    <span className="text-xs muted truncate" style={{ display: "block" }}>{e.itemTitle}</span>
                  </div>
                  <span className="text-xs muted mono" style={{ textAlign: "right" }}>{ageFrom(e.at)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
