import Link from "next/link";
import { Card, CardHead, Ic, PageHead, Pill, StatusPill, type Status } from "@crumb/ui";
import { eq, sql } from "drizzle-orm";
import { db, items } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { hasFeature } from "@/lib/entitlements";
import { accountRiskSignals, atRiskAccounts, atRiskArrCents } from "@/lib/insights/churn";

export const dynamic = "force-dynamic";

// Display order for the status funnel (active → resolved → other).
const STATUS_ORDER: Status[] = ["open", "review", "planned", "progress", "shipped", "declined", "deferred", "duplicate"];
const TYPE_LABEL: Record<string, string> = { bug: "Bugs", idea: "Ideas", question: "Questions", integration: "Integrations" };
const TIER_LABEL: Record<string, string> = { enterprise: "Enterprise (≥$100k)", mid: "Mid-market ($10–100k)", smb: "SMB (<$10k)", none: "No ARR set" };
const TIER_ORDER = ["enterprise", "mid", "smb", "none"];

function humanDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function arr(cents: number): string {
  if (!cents) return "$0";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(1)}M`;
  if (cents >= 100_000) return `$${Math.round(cents / 100_000)}k`;
  return `$${Math.round(cents / 100)}`;
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

// Dependency-free SVG area+line trend. <title> gives native hover tooltips.
function TrendChart({ points }: { points: { label: string; value: number }[] }) {
  const w = 720, h = 120, pad = 10;
  const n = points.length;
  if (n === 0) return null;
  const max = Math.max(1, ...points.map(p => p.value));
  const x = (i: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - 2 * pad));
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Weekly feedback volume">
      <path d={area} fill="var(--accent-soft)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r={2.5} fill="var(--accent-deep)">
          <title>{`${p.label}: ${p.value}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Horizontal bar list (volume by segment).
function BarList({ rows }: { rows: { label: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map(r => r.n));
  return (
    <div className="col gap-3">
      {rows.map(r => (
        <div key={r.label} className="row gap-3 center">
          <span className="text-sm" style={{ width: 160, flexShrink: 0 }}>{r.label}</span>
          <div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${Math.round((r.n / max) * 100)}%`, height: "100%", background: "var(--accent)", borderRadius: 999 }} />
          </div>
          <span className="text-sm" style={{ width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.n}</span>
        </div>
      ))}
    </div>
  );
}

export default async function InsightsPage() {
  const { workspace } = await getActiveSession();
  const ws = workspace.id;
  const aiEntitled = hasFeature(workspace, "ai");

  const [byStatus, byType, volume, respRows, awaitingRows, trendRows, closeRows, tierRows, themeRows, signals] = await Promise.all([
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
    db.execute(sql`
      select count(*)::int as n from items i
      where i.workspace_id = ${ws}::uuid and i.status = 'open'
        and not exists (
          select 1 from replies r
          where r.item_id = i.id and r.workspace_user_id is not null and r.internal = false
        )
    `),
    // 12-week created trend (generate_series fills empty weeks).
    db.execute(sql`
      select to_char(wk, 'Mon DD') as label, coalesce(c.n, 0)::int as n
      from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk
      left join (
        select date_trunc('week', created_at) as w, count(*) as n
        from items where workspace_id = ${ws}::uuid and merged_into_id is null
        group by 1
      ) c on c.w = wk
      order by wk
    `),
    // Time-to-close: submission → first shipped/declined status event.
    db.execute(sql`
      select coalesce(avg(extract(epoch from (se.at - i.created_at))), 0)::float as avg_seconds,
             count(*)::int as closed
      from items i
      join (
        select item_id, min(at) as at from status_events
        where to_status in ('shipped','declined') group by item_id
      ) se on se.item_id = i.id
      where i.workspace_id = ${ws}::uuid
    `),
    // Volume by account ARR tier.
    db.execute(sql`
      select case
               when a.arr_cents >= 10000000 then 'enterprise'
               when a.arr_cents >= 1000000  then 'mid'
               when a.arr_cents > 0         then 'smb'
               else 'none'
             end as tier,
             count(*)::int as n
      from items i join accounts a on a.id = i.account_id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
      group by 1
    `),
    // Top themes (by initiative volume) — the non-AI baseline that always works.
    db.execute(sql`
      select ini.name as name, count(*)::int as n
      from items i join initiatives ini on ini.id = i.initiative_id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
      group by ini.name order by n desc limit 8
    `),
    accountRiskSignals(ws),
  ]);

  const total = volume[0]?.total ?? 0;
  const last30 = volume[0]?.last30 ?? 0;
  const prev30 = volume[0]?.prev30 ?? 0;
  const delta = last30 - prev30;
  const resp = (respRows as unknown as Array<{ avg_seconds: number; responded: number }>)[0] ?? { avg_seconds: 0, responded: 0 };
  const awaiting = (awaitingRows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  const trend = (trendRows as unknown as Array<{ label: string; n: number }>).map(r => ({ label: r.label, value: r.n }));
  const close = (closeRows as unknown as Array<{ avg_seconds: number; closed: number }>)[0] ?? { avg_seconds: 0, closed: 0 };
  const tierMap = new Map((tierRows as unknown as Array<{ tier: string; n: number }>).map(r => [r.tier, r.n]));
  const tierBars = TIER_ORDER.filter(t => (tierMap.get(t) ?? 0) > 0).map(t => ({ label: TIER_LABEL[t], n: tierMap.get(t) ?? 0 }));
  const themes = (themeRows as unknown as Array<{ name: string; n: number }>).map(r => ({ label: r.name, n: r.n }));

  const atRisk = atRiskAccounts(signals).slice(0, 8);
  const sentimentRiskArr = atRiskArrCents(signals);

  const statusCounts = new Map(byStatus.map(r => [r.status as Status, r.n]));
  const maxStatus = Math.max(1, ...byStatus.map(r => r.n));

  return (
    <>
      <PageHead
        crumb="Insights"
        title="Insights"
        lede="Feedback volume, triage health, responsiveness, and revenue at risk."
        actions={
          <>
            {/* Anchors styled as buttons — a <button> inside <a> is invalid HTML
                (causes a hydration mismatch), so use the .btn class directly. */}
            <a href="/qbr" target="_blank" rel="noreferrer" className="btn sm row gap-2 center" style={{ textDecoration: "none" }}>
              <Ic.doc style={{ width: 12, height: 12 }} /> QBR report
            </a>
            <a href="/insights/export" className="btn sm ghost row gap-2 center" style={{ textDecoration: "none" }}>
              <Ic.chevD style={{ width: 12, height: 12 }} /> Export CSV
            </a>
          </>
        }
      />

      <div className="kpi-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Kpi label="Total feedback" value={String(total)} sub={`${last30} in the last 30 days`} />
        <Kpi label="New (30 days)" value={String(last30)} sub={delta === 0 ? "flat vs prior 30d" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)} vs prior 30d`} />
        <Kpi label="Median first response" value={humanDuration(resp.avg_seconds)} sub={`across ${resp.responded} answered`} />
        <Kpi label="Avg time to close" value={humanDuration(close.avg_seconds)} sub={`across ${close.closed} closed`} />
        {aiEntitled && <Kpi label="ARR at risk" value={arr(sentimentRiskArr)} sub="accounts trending negative" />}
      </div>

      <Card>
        <CardHead title="Feedback over time" after={<Pill ring>12 weeks</Pill>} />
        <div className="card-body" style={{ padding: 18 }}>
          {total === 0
            ? <p className="text-sm muted" style={{ margin: 0 }}>No feedback yet. The trend appears once items come in.</p>
            : <TrendChart points={trend} />}
        </div>
      </Card>

      {aiEntitled && atRisk.length > 0 && (
        <Card>
          <CardHead title="Accounts at risk" after={<Pill ring>{arr(sentimentRiskArr)} ARR</Pill>} />
          <div className="card-body col gap-2" style={{ padding: 18 }}>
            <p className="text-xs muted" style={{ margin: "0 0 6px" }}>High-ARR accounts trending negative on sentiment or with open severe issues. Highest revenue first.</p>
            {atRisk.map(a => (
              <Link key={a.accountId} href={`/accounts/${a.accountId}`} className="row gap-3 center between" style={{ textDecoration: "none", color: "inherit", padding: "6px 0", borderBottom: "1px solid var(--hair)" }}>
                <span className="row gap-2 center" style={{ minWidth: 0 }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: a.riskLevel === "high" ? "var(--rust)" : "var(--amber)", flexShrink: 0 }} />
                  <span className="serif text-md truncate">{a.name}</span>
                </span>
                <span className="row gap-3 center text-xs muted" style={{ flexShrink: 0 }}>
                  <span className="mono">{arr(a.arrCents)}</span>
                  {a.sentimentTrend != null && <span style={{ color: a.sentimentTrend < 0 ? "var(--rust)" : "var(--green)" }}>{a.sentimentTrend < 0 ? "↓" : "↑"} {a.sentimentTrend.toFixed(2)}</span>}
                  {a.openCount > 0 && <span>{a.openCount} open</span>}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHead title="Status funnel" after={<Pill ring>{total} items</Pill>} />
        <div className="card-body col gap-3" style={{ padding: 18 }}>
          {total === 0 ? (
            <p className="text-sm muted" style={{ margin: 0 }}>No feedback yet. Once items come in, they'll break down by status here.</p>
          ) : (
            STATUS_ORDER.filter(s => (statusCounts.get(s) ?? 0) > 0).map(s => {
              const n = statusCounts.get(s) ?? 0;
              return (
                <div key={s} className="row gap-3 center">
                  <div style={{ width: 120, flexShrink: 0 }}><StatusPill status={s} /></div>
                  <div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${Math.round((n / maxStatus) * 100)}%`, height: "100%", background: "var(--accent)", borderRadius: 999 }} />
                  </div>
                  <span className="text-sm" style={{ width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n}</span>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <div className="cols-2-1" style={{ alignItems: "start" }}>
        <Card>
          <CardHead title="Volume by account tier" />
          <div className="card-body" style={{ padding: 18 }}>
            {tierBars.length === 0 ? <span className="text-sm muted">—</span> : <BarList rows={tierBars} />}
          </div>
        </Card>
        <Card>
          <CardHead title="Top themes" />
          <div className="card-body" style={{ padding: 18 }}>
            {themes.length === 0
              ? <p className="text-sm muted" style={{ margin: 0 }}>Assign items to initiatives to see themes rank here.</p>
              : <BarList rows={themes} />}
          </div>
        </Card>
      </div>

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
