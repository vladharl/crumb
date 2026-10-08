import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { loopOpenSql } from "@/lib/loop-sql";

export type QbrActivity = { new_90: number; shipped_90: number; open_now: number };

// The QBR's activity KPIs, unmerged items only. Shipped counts the move to
// Shipped inside the 90 days (status_events), not the last touch: a reply or
// an edit on something shipped last year bumps updated_at, not this. Raw refs
// stay fully qualified inside the correlated subquery.
export async function qbrActivity(workspaceId: string): Promise<QbrActivity> {
  const rows = await db.execute(sql`
    select
      count(*) filter (where created_at >= now() - interval '90 days')::int as new_90,
      count(*) filter (where status = 'shipped' and exists (
        select 1 from status_events se
        where se.item_id = items.id and se.to_status = 'shipped' and se.at >= now() - interval '90 days'
      ))::int as shipped_90,
      count(*) filter (where ${loopOpenSql(sql`status`)})::int as open_now
    from items where workspace_id = ${workspaceId}::uuid and merged_into_id is null
  `);
  return (rows as unknown as QbrActivity[])[0] ?? { new_90: 0, shipped_90: 0, open_now: 0 };
}
