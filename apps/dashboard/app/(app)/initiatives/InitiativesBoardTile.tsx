import { db, initiatives, workspaceUsers } from "@crumb/db";
import { asc, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { loopOpenSql } from "@/lib/loop-sql";
import { followerCountSql, shippedAtSql } from "@/lib/roadmap";
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
      // Correlated on fully-qualified raw refs, NOT ${initiatives.id}: inside
      // a raw subquery template drizzle renders an interpolated column
      // unqualified ("id"), which resolves to the subquery's own id column
      // instead of the outer initiatives.id, silently making these 0.
      followers: followerCountSql(),
      shippedAt: shippedAtSql(),
      // Revenue at stake: ARR over the DISTINCT accounts with OPEN feedback in
      // this initiative — the same unit the inbox ranks on, rolled up. Open
      // loops only (not closed, Set aside included: lib/loop-sql); merged dupes
      // excluded. Same fully-qualified-ref caveat as `followers` above.
      // ::bigint → mapper Number()s it (a portfolio sum can exceed int4).
      arrAtStake: sql<string>`(
        SELECT COALESCE(SUM(a.arr_cents), 0)::bigint FROM (
          SELECT DISTINCT it.account_id FROM items it
          WHERE it.initiative_id = initiatives.id
            AND it.merged_into_id IS NULL
            AND ${loopOpenSql(sql`it.status`)}
        ) g JOIN accounts a ON a.id = g.account_id
      )`,
      accountCount: sql<number>`(
        SELECT COUNT(DISTINCT it.account_id)::int FROM items it
        WHERE it.initiative_id = initiatives.id
          AND it.merged_into_id IS NULL
          AND ${loopOpenSql(sql`it.status`)}
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
    shippedAt: r.shippedAt?.toISOString() ?? null,
  }));

  const canManage = user.role === "admin" || user.role === "pm";
  return <InitiativesBoard initial={initial} canManage={canManage} />;
}
