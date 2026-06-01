import { Card, CardHead, Pill } from "@crumb/ui";
import { db, initiatives, items } from "@crumb/db";
import { and, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { usageAnalyticsAllowed } from "@/lib/entitlements";
import { adoptionAround } from "@/lib/usage/signals";

// Quantitative "did it work?" for a shipped initiative — closes crumb's loop.
// Compares adoption of the initiative's tracked events in equal windows
// before/after it shipped, alongside the sentiment shift of its feedback.
// Hidden unless the workspace is entitled, the initiative is shipped, and it
// has trackedEventNames configured.

function pct(before: number, after: number): string {
  if (before === 0) return after > 0 ? `0 → ${after}` : "no change";
  const delta = ((after - before) / before) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${before} → ${after} (${sign}${delta.toFixed(0)}%)`;
}

export async function InitiativeImpactTile({ id }: { id: string }) {
  const { workspace } = await getActiveSession();
  if (!usageAnalyticsAllowed(workspace)) return null;

  const [ini] = await db
    .select({
      status: initiatives.status,
      trackedEventNames: initiatives.trackedEventNames,
      // Best-available ship timestamp: when the initiative was last changed
      // (presumed → shipped). Initiatives have no dedicated shipped_at column.
      updatedAt: initiatives.updatedAt,
    })
    .from(initiatives)
    .where(and(eq(initiatives.workspaceId, workspace.id), eq(initiatives.id, id)))
    .limit(1);

  if (!ini || ini.status !== "shipped") return null;
  const names = ini.trackedEventNames ?? [];
  if (names.length === 0) return null;

  const pivot = ini.updatedAt;
  const adoption = await adoptionAround({ workspaceId: workspace.id, eventNames: names, pivot, windowDays: 30 });

  // Sentiment of this initiative's feedback, 30d before vs 30d after the ship.
  const sentRows = (await db.execute(sql`
    SELECT
      AVG(ai_sentiment) FILTER (
        WHERE created_at >= ${pivot}::timestamptz - interval '30 days' AND created_at < ${pivot}
      ) AS before_s,
      AVG(ai_sentiment) FILTER (
        WHERE created_at >= ${pivot} AND created_at < ${pivot}::timestamptz + interval '30 days'
      ) AS after_s
    FROM items
    WHERE initiative_id = ${id} AND merged_into_id IS NULL
  `)) as unknown as Array<{ before_s: number | string | null; after_s: number | string | null }>;
  const beforeS = sentRows[0]?.before_s != null ? Number(sentRows[0].before_s) : null;
  const afterS = sentRows[0]?.after_s != null ? Number(sentRows[0].after_s) : null;

  // Nothing to say if there's neither adoption nor sentiment signal.
  if (!adoption && beforeS == null && afterS == null) return null;

  return (
    <Card>
      <CardHead title="Impact since shipping" after={<Pill ring>{names.length} event{names.length > 1 ? "s" : ""}</Pill>} />
      <div className="card-body col gap-3">
        {adoption && (
          <div className="col gap-1">
            <span className="eyebrow">Adoption · accounts active 30d before → after</span>
            <span className="text-md">{pct(adoption.before, adoption.after)}</span>
          </div>
        )}
        {(beforeS != null || afterS != null) && (
          <div className="col gap-1">
            <span className="eyebrow">Feedback sentiment · 30d before → after</span>
            <span className="text-md">
              {beforeS != null ? beforeS.toFixed(2) : "—"} → {afterS != null ? afterS.toFixed(2) : "—"}
            </span>
          </div>
        )}
        <span className="text-2xs muted">Tracked: {names.join(", ")}</span>
      </div>
    </Card>
  );
}
