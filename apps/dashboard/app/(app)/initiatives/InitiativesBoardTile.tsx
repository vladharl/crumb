import { db, initiatives, workspaceUsers } from "@crumb/db";
import { asc, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { InitiativesBoard, type BoardItem } from "./InitiativesBoard";

export async function InitiativesBoardTile() {
  const { workspace, user } = await getActiveSession();

  const rows = await db
    .select({
      id: initiatives.id,
      shortId: initiatives.shortId,
      name: initiatives.name,
      status: initiatives.status,
      color: initiatives.color,
      roadmapColumn: initiatives.roadmapColumn,
      roadmapOrder: initiatives.roadmapOrder,
      isPublic: initiatives.isPublic,
      createdAt: initiatives.createdAt,
      ownerName: workspaceUsers.name,
      // Correlate with a fully-qualified raw ref, NOT ${initiatives.id}:
      // inside a raw subquery template drizzle renders an interpolated column
      // unqualified ("id"), which resolves to roadmap_follows.id (it has an id
      // col) instead of the outer initiatives.id — silently making this 0.
      followers: sql<number>`(
        SELECT COUNT(*)::int FROM roadmap_follows WHERE roadmap_follows.initiative_id = initiatives.id
      )`,
      // Revenue at stake: ARR over the DISTINCT accounts with OPEN feedback in
      // this initiative — the same unit the inbox ranks on, rolled up. Open
      // statuses only (shipped work is done); merged dupes excluded. Same
      // fully-qualified-ref caveat as `followers` above. ::bigint → mapper
      // Number()s it (a portfolio sum can exceed int4).
      arrAtStake: sql<string>`(
        SELECT COALESCE(SUM(a.arr_cents), 0)::bigint FROM (
          SELECT DISTINCT it.account_id FROM items it
          WHERE it.initiative_id = initiatives.id
            AND it.merged_into_id IS NULL
            AND it.status IN ('open','review','planned','progress')
        ) g JOIN accounts a ON a.id = g.account_id
      )`,
      accountCount: sql<number>`(
        SELECT COUNT(DISTINCT it.account_id)::int FROM items it
        WHERE it.initiative_id = initiatives.id
          AND it.merged_into_id IS NULL
          AND it.status IN ('open','review','planned','progress')
      )`,
    })
    .from(initiatives)
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, initiatives.ownerWorkspaceUserId))
    .where(eq(initiatives.workspaceId, workspace.id))
    .orderBy(asc(initiatives.roadmapOrder), asc(initiatives.seq));

  const initial: BoardItem[] = rows.map(r => ({
    id: r.id,
    shortId: r.shortId,
    name: r.name,
    status: r.status,
    color: r.color,
    column: (r.roadmapColumn as BoardItem["column"]) ?? null,
    order: r.roadmapOrder ?? 0,
    isPublic: r.isPublic,
    followers: r.followers,
    arrAtStakeCents: Number(r.arrAtStake),
    accountCount: r.accountCount,
    ownerName: r.ownerName ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  const canManage = user.role === "admin" || user.role === "pm";
  return <InitiativesBoard initial={initial} canManage={canManage} />;
}
