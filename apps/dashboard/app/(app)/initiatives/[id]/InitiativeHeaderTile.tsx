import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageHead, Pill } from "@crumb/ui";
import { db, initiatives, items, workspaceUsers } from "@crumb/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { InitiativeStatusPill } from "../InitiativeChip";
import { EditPanel } from "./EditPanel";

async function loadHeader(workspaceId: string, id: string) {
  const [row] = await db
    .select({
      id: initiatives.id,
      shortId: initiatives.shortId,
      name: initiatives.name,
      description: initiatives.description,
      status: initiatives.status,
      color: initiatives.color,
      createdAt: initiatives.createdAt,
      updatedAt: initiatives.updatedAt,
      ownerWorkspaceUserId: initiatives.ownerWorkspaceUserId,
      trackedEventNames: initiatives.trackedEventNames,
      ownerName: workspaceUsers.name,
      ownerInitials: workspaceUsers.initials,
    })
    .from(initiatives)
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, initiatives.ownerWorkspaceUserId))
    .where(and(eq(initiatives.workspaceId, workspaceId), eq(initiatives.id, id)))
    .limit(1);
  if (!row) return null;

  const [statsRows, [{ count: total }]] = await Promise.all([
    db
      .select({ status: items.status, count: sql<number>`COUNT(*)::int` })
      .from(items)
      .where(eq(items.initiativeId, id))
      .groupBy(items.status),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(items)
      .where(eq(items.initiativeId, id)),
  ]);

  const m = new Map(statsRows.map(r => [r.status, r.count]));
  const get = (s: string) => m.get(s) ?? 0;
  const stats = {
    open: get("open") + get("review"),
    progress: get("planned") + get("progress"),
    shipped: get("shipped"),
    declined: get("declined"),
    deferred: get("deferred"),
    duplicate: get("duplicate"),
  };

  return { initiative: row, stats, total };
}

export async function InitiativeHeaderTile({ id }: { id: string }) {
  const { workspace, user } = await getActiveSession();
  const data = await loadHeader(workspace.id, id);
  if (!data) notFound();
  const canManage = user.role === "admin" || user.role === "pm";
  const { initiative, stats, total } = data;

  // Teammates who can own this initiative — populates the owner picker.
  const members = canManage
    ? await db
        .select({ id: workspaceUsers.id, name: workspaceUsers.name })
        .from(workspaceUsers)
        .where(eq(workspaceUsers.workspaceId, workspace.id))
        .orderBy(asc(workspaceUsers.name))
    : [];

  return (
    <>
      <PageHead
        crumb={<Link href="/initiatives" style={{ color: "inherit" }}>Initiatives</Link>}
        title={initiative.name}
        lede={initiative.description ?? "Vendor-internal bucket. Group inbound feedback that belongs together so you can triage themes, not just rows."}
        actions={
          <EditPanel
            initiative={{
              id: initiative.id,
              name: initiative.name,
              description: initiative.description,
              status: initiative.status,
              color: initiative.color,
              ownerWorkspaceUserId: initiative.ownerWorkspaceUserId,
              trackedEventNames: initiative.trackedEventNames,
            }}
            members={members}
            canManage={canManage}
          />
        }
      />

      <Card>
        <div className="card-body row gap-5" style={{ alignItems: "center", flexWrap: "wrap" }}>
          {initiative.color && (
            <span
              aria-hidden
              style={{
                width: 44, height: 44, borderRadius: "50%",
                background: initiative.color, flexShrink: 0,
                border: "1px solid var(--line)",
              }}
            />
          )}
          <div className="col gap-2 grow" style={{ minWidth: 220 }}>
            <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
              <span className="mono text-xs muted">{initiative.shortId}</span>
              <InitiativeStatusPill status={initiative.status} />
              {initiative.ownerName && <Pill>Owner · {initiative.ownerName}</Pill>}
            </div>
            <div className="text-sm muted">
              {total} {total === 1 ? "item" : "items"} grouped here.
            </div>
          </div>
          <div className="row gap-6" style={{ alignItems: "flex-end" }}>
            {[
              [String(stats.open),     "Open"],
              [String(stats.progress), "In progress"],
              [String(stats.shipped),  "Shipped"],
              [String(stats.declined + stats.deferred + stats.duplicate), "Closed"],
            ].map(([n, l]) => (
              <div key={l} className="kpi" style={{ alignItems: "center" }}>
                <span className="num">{n}</span>
                <span className="lbl">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
