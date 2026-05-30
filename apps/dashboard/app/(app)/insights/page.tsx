import { Card, CardHead, PageHead, Pill, StatusPill, type Status } from "@crumb/ui";
import { and, eq, sql } from "drizzle-orm";
import { db, items } from "@crumb/db";
import { getActiveSession } from "@/lib/server";

export const dynamic = "force-dynamic";

// Display order for the status funnel (active → resolved → other).
const STATUS_ORDER: Status[] = ["open", "review", "planned", "progress", "shipped", "declined", "deferred", "duplicate"];
const TYPE_LABEL: Record<string, string> = { bug: "Bugs", idea: "Ideas", question: "Questions", integration: "Integrations" };

function humanDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div className="card-body col gap-1" style={{ padding: "16px 18px" }}>
        <span className="eyebrow">{label}</span>
        <span className="serif" style={{ fontSize: 28, lineHeight: 1.1 }}>{value}</span>
        {sub && <span className="text-xs muted">{sub}</span>}
      </div>
    </Card>
  );
}

export default async function InsightsPage() {
  const { workspace } = await getActiveSession();
  const ws = workspace.id;

  // Counts grouped by status + type.
  const [byStatus, byType, volume, respRows, awaitingRows] = await Promise.all([
    db.select({ status: items.status, n: sql<number>`count(*)::int` })
      .from(items).where(eq(items.workspaceId, ws)).groupBy(items.status),
    db.select({ type: items.type, n: sql<number>`count(*)::int` })
      .from(items).where(eq(items.workspaceId, ws)).groupBy(items.type),
    db.select({
      total:  sql<number>`count(*)::int`,
      last30: sql<number>`count(*) filter (where ${items.createdAt} >= now() - interval '30 days')::int`,
      prev30: sql<number>`count(*) filter (where ${items.createdAt} >= now() - interval '60 days' and ${items.createdAt} < now() - interval '30 days')::int`,
    }).from(items).where(eq(items.workspaceId, ws)),
    // Avg time from submission to first vendor reply, over items that got one.
    db.execute(sql`
      select coalesce(avg(extract(epoch from (fr.first_reply - i.created_at))), 0)::float as avg_seconds,
             count(*)::int as responded
      from items i
      join (
        select item_id, min(created_at) as first_reply
        from replies where workspace_user_id is not null and internal = false
        group by item_id
      ) fr on fr.item_id = i.id
      where i.workspace_id = ${ws}::uuid
    `),
    // Open items still awaiting a first vendor reply.
    db.execute(sql`
      select count(*)::int as n from items i
      where i.workspace_id = ${ws}::uuid and i.status = 'open'
        and not exists (
          select 1 from replies r
          where r.item_id = i.id and r.workspace_user_id is not null and r.internal = false
        )
    `),
  ]);

  const total = volume[0]?.total ?? 0;
  const last30 = volume[0]?.last30 ?? 0;
  const prev30 = volume[0]?.prev30 ?? 0;
  const delta = last30 - prev30;
  const resp = (respRows as unknown as Array<{ avg_seconds: number; responded: number }>)[0] ?? { avg_seconds: 0, responded: 0 };
  const awaiting = (awaitingRows as unknown as Array<{ n: number }>)[0]?.n ?? 0;

  const statusCounts = new Map(byStatus.map(r => [r.status as Status, r.n]));
  const maxStatus = Math.max(1, ...byStatus.map(r => r.n));

  return (
    <>
      <PageHead
        crumb="Insights"
        title="Insights"
        lede="Feedback volume, triage health, and responsiveness for this workspace."
        actions={<Pill ring>Live</Pill>}
      />

      <div className="kpi-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="Total feedback" value={String(total)} sub={`${last30} in the last 30 days`} />
        <Kpi
          label="New (30 days)"
          value={String(last30)}
          sub={delta === 0 ? "flat vs prior 30d" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)} vs prior 30d`}
        />
        <Kpi label="Awaiting first reply" value={String(awaiting)} sub="open, no vendor response yet" />
        <Kpi label="Median first response" value={humanDuration(resp.avg_seconds)} sub={`across ${resp.responded} answered`} />
      </div>

      <Card>
        <CardHead title="Status funnel" after={<Pill ring>{total} items</Pill>} />
        <div className="card-body col gap-3" style={{ padding: 18 }}>
          {total === 0 ? (
            <p className="text-sm muted" style={{ margin: 0 }}>No feedback yet — once items come in, they'll break down by status here.</p>
          ) : (
            STATUS_ORDER.filter(s => (statusCounts.get(s) ?? 0) > 0).map(s => {
              const n = statusCounts.get(s) ?? 0;
              return (
                <div key={s} className="row gap-3 center">
                  <div style={{ width: 120, flexShrink: 0 }}><StatusPill status={s} /></div>
                  <div style={{ flex: 1, height: 8, background: "var(--bone-2, var(--surface-2))", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${Math.round((n / maxStatus) * 100)}%`, height: "100%", background: "var(--accent, #E27D3A)", borderRadius: 999 }} />
                  </div>
                  <span className="text-sm" style={{ width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n}</span>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <Card>
        <CardHead title="By type" />
        <div className="card-body row gap-6" style={{ padding: 18, flexWrap: "wrap" }}>
          {byType.length === 0 ? (
            <span className="text-sm muted">—</span>
          ) : (
            byType.map(t => (
              <div key={t.type} className="col gap-1">
                <span className="serif" style={{ fontSize: 22, lineHeight: 1.1 }}>{t.n}</span>
                <span className="text-xs muted">{TYPE_LABEL[t.type] ?? t.type}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
