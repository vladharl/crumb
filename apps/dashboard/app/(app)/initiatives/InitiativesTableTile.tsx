import Link from "next/link";
import { Card } from "@crumb/ui";
import { db, initiatives, items, workspaceUsers } from "@crumb/db";
import { desc, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { InitiativeChip, InitiativeStatusPill } from "./InitiativeChip";

const GRID = "60px 1.6fr 100px 70px 70px 140px";

async function loadInitiatives(workspaceId: string) {
  const totalCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${items}
    WHERE ${items.initiativeId} = ${initiatives.id}
  )`.as("total_count");
  const openCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${items}
    WHERE ${items.initiativeId} = ${initiatives.id}
      AND ${items.status} IN ('open','review','planned','progress')
  )`.as("open_count");

  return db
    .select({
      id: initiatives.id,
      shortId: initiatives.shortId,
      name: initiatives.name,
      description: initiatives.description,
      status: initiatives.status,
      color: initiatives.color,
      ownerName: workspaceUsers.name,
      ownerInitials: workspaceUsers.initials,
      createdAt: initiatives.createdAt,
      totalCount,
      openCount,
    })
    .from(initiatives)
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, initiatives.ownerWorkspaceUserId))
    .where(eq(initiatives.workspaceId, workspaceId))
    .orderBy(desc(initiatives.updatedAt));
}

export async function InitiativesTableTile() {
  const { workspace, user } = await getActiveSession();
  const canManage = user.role === "admin" || user.role === "pm";
  const rows = await loadInitiatives(workspace.id);

  if (rows.length === 0) {
    return (
      <Card>
        <div className="col gap-3" style={{ padding: "24px 4px", textAlign: "center", alignItems: "center" }}>
          <p className="text-sm muted" style={{ margin: 0, maxWidth: "52ch", lineHeight: 1.6 }}>
            No initiatives yet. Create one to start grouping related asks — handy when 30+ items pile up under the same theme.
          </p>
          {!canManage && (
            <p className="text-xs muted" style={{ margin: 0 }}>
              Ask a workspace admin to add the first one.
            </p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card style={{ padding: 0 }}>
      <div className="list">
        <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
          <span>ID</span>
          <span>Initiative</span>
          <span>Status</span>
          <span>Open</span>
          <span>Total</span>
          <span>Owner</span>
        </div>
        {rows.map(r => (
          <Link
            key={r.id}
            href={`/initiatives/${r.id}`}
            className="list-row"
            style={{ gridTemplateColumns: GRID }}
          >
            <span className="mono text-xs muted">{r.shortId}</span>
            <div className="col" style={{ minWidth: 0 }}>
              <InitiativeChip initiative={{ id: r.id, shortId: r.shortId, name: r.name, color: r.color, status: r.status }} />
              {r.description && (
                <span className="text-xs muted truncate" style={{ marginTop: 2, maxWidth: "60ch" }}>
                  {r.description}
                </span>
              )}
            </div>
            <span><InitiativeStatusPill status={r.status} /></span>
            <span className="text-sm">{r.openCount > 0 ? r.openCount : <span className="muted-2">—</span>}</span>
            <span className="text-sm muted">{r.totalCount}</span>
            <span className="text-xs muted truncate" title={r.ownerName ?? ""}>
              {r.ownerName ?? "Unassigned"}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
