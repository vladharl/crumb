import "server-only";
import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { db, initiatives } from "@crumb/db";

// The customer roadmap: Now, Next and Later are board columns; Shipped is a
// status, so a shipped initiative sits in Shipped whatever its column (and
// goes back to that column if it's un-shipped).
export type RoadmapLane = "now" | "next" | "later" | "shipped";

const SCHEDULED_COLUMNS = ["now", "next", "later"];

export type PublicRoadmapEntry = {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  lane: RoadmapLane;
  status: string;
  shippedAt: string | null; // ISO; null unless the lane is "shipped"
};

// What customers can see: a public initiative that's scheduled or shipped. A
// public card left in Unscheduled stays hidden.
export function onPublicRoadmapSql(): SQL {
  return and(
    eq(initiatives.isPublic, true),
    or(eq(initiatives.status, "shipped"), inArray(initiatives.roadmapColumn, SCHEDULED_COLUMNS)),
  )!;
}

// When a shipped initiative shipped; null for the rest. Shipping writes its
// changelog draft (updateInitiative), so the draft's date is the ship date; one
// shipped before drafts existed, or whose draft was deleted, falls back to its
// last edit. Raw refs stay fully qualified inside the correlated subquery.
// ponytail: re-shipping keeps the first draft's date; add initiatives.shipped_at if that matters.
export function shippedAtSql(): SQL<Date | null> {
  return sql`CASE WHEN initiatives.status = 'shipped' THEN COALESCE(
    (SELECT MAX(changelog_entries.created_at) FROM changelog_entries
      WHERE changelog_entries.workspace_id = initiatives.workspace_id
        AND changelog_entries.initiative_id = initiatives.id),
    initiatives.updated_at
  ) END`.mapWith(initiatives.updatedAt);
}

// Everyone a public initiative's roadmap move emails: widget followers plus
// confirmed, still-subscribed followers from the public roadmap page, who are
// only emailed while the workspace's public pages are on (lib/public-follows).
export function followerCountSql() {
  return sql<number>`((
    SELECT COUNT(*)::int FROM roadmap_follows WHERE roadmap_follows.initiative_id = initiatives.id
  ) + (
    SELECT COUNT(*)::int FROM public_follows
      JOIN workspaces ON workspaces.id = public_follows.workspace_id
    WHERE public_follows.initiative_id = initiatives.id
      AND workspaces.public_pages_enabled
      AND public_follows.confirmed_at IS NOT NULL AND public_follows.unsubscribed_at IS NULL
  ))`;
}

/**
 * The public roadmap for the widget and the public page: public initiatives in
 * Now, Next and Later in board order, then the most recently shipped (newest
 * first, `shippedLimit` of them). Never internal notes, followers or revenue.
 */
export async function listPublicRoadmap(
  workspaceId: string,
  opts: { shippedLimit?: number } = {},
): Promise<PublicRoadmapEntry[]> {
  const fields = {
    id: initiatives.id,
    shortId: initiatives.shortId,
    name: initiatives.name,
    description: initiatives.description,
    status: initiatives.status,
    column: initiatives.roadmapColumn,
    shippedAt: shippedAtSql(),
  };
  const [scheduled, shipped] = await Promise.all([
    db.select(fields).from(initiatives)
      .where(and(
        eq(initiatives.workspaceId, workspaceId),
        eq(initiatives.isPublic, true),
        ne(initiatives.status, "shipped"),
        inArray(initiatives.roadmapColumn, SCHEDULED_COLUMNS),
      ))
      // The board's order (InitiativesBoard sortCards).
      .orderBy(asc(initiatives.roadmapOrder), asc(initiatives.shortId)),
    db.select(fields).from(initiatives)
      .where(and(
        eq(initiatives.workspaceId, workspaceId),
        eq(initiatives.isPublic, true),
        eq(initiatives.status, "shipped"),
      ))
      .orderBy(desc(fields.shippedAt), desc(initiatives.seq))
      .limit(opts.shippedLimit ?? 10),
  ]);

  const entry = (r: (typeof scheduled)[number], lane: RoadmapLane): PublicRoadmapEntry => ({
    id: r.id,
    shortId: r.shortId,
    name: r.name,
    description: r.description,
    lane,
    status: r.status,
    shippedAt: r.shippedAt?.toISOString() ?? null,
  });
  return [
    ...scheduled.map(r => entry(r, r.column as RoadmapLane)),
    ...shipped.map(r => entry(r, "shipped")),
  ];
}
