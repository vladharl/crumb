import type { ReactNode } from "react";
import Link from "next/link";
import { Card, CardHead, Ic, PageHead, Pill, StatusPill, STATUS_LABELS, type Status } from "@crumb/ui";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { hasFeature } from "@/lib/entitlements";
import { accountRiskSignals, atRiskAccounts, atRiskArrCents } from "@/lib/insights/churn";
import { loopOpenSql } from "@/lib/loop-sql";
import { formatArr } from "@/lib/priority";
import { formatDate } from "@/lib/timefmt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

// Display order for the status breakdown: every status (the customer's own
// "resolved" close included), so the bars add up to the item-count pill.
const STATUS_ORDER = Object.keys(STATUS_LABELS) as Status[];
const TYPE_LABEL: Record<string, string> = { bug: "Bugs", idea: "Ideas", question: "Questions", integration: "Integrations" };
const TIER_LABEL: Record<string, string> = { enterprise: "Enterprise (≥$100k)", mid: "Mid-market ($10–100k)", smb: "SMB (<$10k)", none: "ARR not set" };
const TIER_ORDER = ["enterprise", "mid", "smb", "none"] as const;

// Tonal brown ramp for the tier mix — stays two-tone, no second hue.
const TIER_COLOR: Record<string, string> = {
  enterprise: "var(--text)",
  mid: "rgba(74,46,31,0.74)",
  smb: "rgba(74,46,31,0.48)",
  none: "rgba(74,46,31,0.24)",
};

// Status bars take the status family's own color (matching the pill beside
// them). Ember stays the active path — only planned/in-progress — so the
// One-Trail rule holds and the bar never contradicts its label.
const STATUS_BAR_COLOR: Record<Status, string> = {
  open: "rgba(74,46,31,0.42)",
  review: "rgba(74,46,31,0.42)",
  duplicate: "rgba(74,46,31,0.22)",
  planned: "var(--accent)",
  progress: "var(--accent)",
  shipped: "var(--green)",
  declined: "var(--rust)",
  deferred: "var(--amber)",
  resolved: "rgba(107,142,90,0.55)",
};

// Time-range scope. Windows the "flow" metrics (loop time, response, volume,
// breakdowns) and gives each a prior-period to compare against. Snapshot
// metrics (open loops, ARR at risk) ignore it — they're always "right now".
const RANGES: Record<string, { days: number | null; label: string; short: string }> = {
  "30d":  { days: 30,   label: "30 days",   short: "30d" },
  "90d":  { days: 90,   label: "90 days",   short: "90d" },
  "12mo": { days: 365,  label: "12 months", short: "12mo" },
  all:    { days: null, label: "all time",  short: "All" },
};
const RANGE_KEYS = ["30d", "90d", "12mo", "all"] as const;
const DEFAULT_RANGE = "90d";

function humanDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

type Delta = { arrow: string; mag: string; word: string; tone: "good" | "bad" | "muted" } | null;

// Period-over-period change for a duration metric (lower is better, so a drop
// reads green/"faster"). Null when there's no prior window or no data to compare.
function durDelta(cur: number, prev: number, curN: number, prevN: number, wDays: number | null): Delta {
  if (wDays == null || !curN || !prevN) return null;
  const d = Math.round(cur - prev);
  if (Math.abs(d) < 60) return { arrow: "", mag: "", word: "about the same", tone: "muted" };
  const faster = d < 0;
  return { arrow: faster ? "↓" : "↑", mag: humanDuration(Math.abs(d)), word: faster ? "faster" : "slower", tone: faster ? "good" : "bad" };
}

function deltaTone(tone: "good" | "bad" | "muted") {
  return tone === "good" ? "var(--green-deep)" : tone === "bad" ? "var(--rust-deep)" : "var(--mute)";
}

function deltaNode(d: Delta): ReactNode {
  if (!d) return null;
  return (
    <span className="text-xs" style={{ color: deltaTone(d.tone), fontWeight: 500 }}>
      {d.arrow ? `${d.arrow} ` : ""}{d.mag ? `${d.mag} ` : ""}{d.word}
    </span>
  );
}

const DownloadIc = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M8 2.5v7.5m0 0L4.8 6.8M8 10l3.2-3.2M3 13.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Kpi({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: ReactNode }) {
  return (
    <Card>
      <div className="card-body col gap-1" style={{ padding: "16px 18px" }}>
        <span className="eyebrow">{label}</span>
        <span className="serif" style={{ fontSize: 28, lineHeight: 1.1 }}>{value}</span>
        {delta}
        {sub && <span className="text-xs muted">{sub}</span>}
      </div>
    </Card>
  );
}

// Dependency-free SVG trend. Scales uniformly (no preserveAspectRatio="none",
// which would stretch the stroke and turn the dots into ovals), draws its own
// baseline + max gridline, and labels the axis so values are readable without
// hovering. <title> still gives native per-point tooltips.
function TrendChart({ points }: { points: { label: string; value: number }[] }) {
  const n = points.length;
  if (n === 0) return null;
  const w = 1000, h = 150, padX = 6, padTop = 16, padBottom = 24;
  const max = Math.max(1, ...points.map(p => p.value));
  const peakIdx = points.reduce((m, p, i) => (p.value > points[m].value ? i : m), 0);
  const base = h - padBottom;
  const x = (i: number) => padX + (n <= 1 ? (w - 2 * padX) / 2 : (i / (n - 1)) * (w - 2 * padX));
  const y = (v: number) => padTop + (1 - v / max) * (h - padTop - padBottom);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`;
  const labelIdx = points.map((_, i) => i).filter(i => i % 3 === 0 || i === n - 1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block", height: "auto" }} role="img" aria-label={`Weekly feedback volume over ${n} weeks, peak ${max}`}>
      <line x1={padX} y1={y(max)} x2={w - padX} y2={y(max)} stroke="var(--hair)" strokeDasharray="3 5" />
      <text x={padX} y={y(max) - 4} fontSize="11" fill="var(--mute)">{max}</text>
      <line x1={padX} y1={base} x2={w - padX} y2={base} stroke="var(--hair)" />
      <path d={area} fill="var(--brown-06)" />
      <path d={line} fill="none" stroke="var(--brown-65)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r={i === peakIdx ? 3.5 : 2.5} fill={i === peakIdx ? "var(--text)" : "var(--brown-65)"}>
          <title>{`${p.label}: ${p.value}`}</title>
        </circle>
      ))}
      {max > 0 && <text x={x(peakIdx)} y={y(points[peakIdx].value) - 8} fontSize="11" fontWeight="600" fill="var(--text)" textAnchor="middle">{points[peakIdx].value}</text>}
      {labelIdx.map(i => (
        <text key={i} x={x(i)} y={h - 7} fontSize="11" fill="var(--mute)" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{points[i].label}</text>
      ))}
    </svg>
  );
}

// Horizontal bar list (themes). Leading row takes the full mid-brown as the
// highlight, the rest a quieter brown: a ranking isn't the trail, so no ember
// (One-Trail Rule). Labels truncate.
function BarList({ rows, accentTop = false }: { rows: { label: string; n: number }[]; accentTop?: boolean }) {
  const max = Math.max(1, ...rows.map(r => r.n));
  return (
    <div className="col gap-3">
      {rows.map((r, i) => (
        <div key={r.label} className="row gap-3 center">
          <span className="text-sm truncate" title={r.label} style={{ width: 150, flexShrink: 0 }}>{r.label}</span>
          <div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${Math.round((r.n / max) * 100)}%`, height: "100%", background: accentTop && i === 0 ? "var(--brown-65)" : "var(--brown-30)", borderRadius: 999 }} />
          </div>
          <span className="text-sm tabular" style={{ width: 32, textAlign: "right" }}>{r.n}</span>
        </div>
      ))}
    </div>
  );
}

// Single proportional bar for the tier mix — a different idiom from the lists,
// and a denser read of "where the volume sits" across revenue bands.
function TierStacked({ rows, total }: { rows: { key: string; label: string; n: number }[]; total: number }) {
  return (
    <div className="col gap-4">
      <div style={{ display: "flex", height: 16, borderRadius: 999, overflow: "hidden", background: "var(--surface-2)" }}>
        {rows.map(r => (
          <div key={r.key} title={`${r.label}: ${r.n}`} style={{ width: `${(r.n / total) * 100}%`, height: "100%", background: TIER_COLOR[r.key], minWidth: r.n > 0 ? 2 : 0 }} />
        ))}
      </div>
      <div className="col gap-2">
        {rows.map(r => (
          <div key={r.key} className="row center between">
            <span className="row center gap-2 text-sm">
              <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, background: TIER_COLOR[r.key], flexShrink: 0 }} />
              {r.label}
            </span>
            <span className="text-sm muted tabular">{r.n} · {Math.round((r.n / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function InsightsPage({ searchParams }: { searchParams?: { range?: string } }) {
  const { workspace } = await getActiveSession();
  const ws = workspace.id;
  const aiEntitled = hasFeature(workspace, "ai");

  const rangeKey = searchParams?.range && RANGES[searchParams.range] ? searchParams.range : DEFAULT_RANGE;
  const wDays = RANGES[rangeKey].days;
  const windowLabel = RANGES[rangeKey].label;
  const scopedSub = wDays == null ? "all time" : `last ${windowLabel}`;

  // Window fragments, composed into the queries below. `i` is the items alias.
  // Every card counts unmerged items only (i.merged_into_id is null), so a
  // duplicate folded into its canonical item counts once.
  const curW = wDays == null ? sql`true` : sql`i.created_at >= now() - make_interval(days => ${wDays})`;
  const prevW = wDays == null ? sql`false` : sql`i.created_at >= now() - make_interval(days => ${wDays * 2}) and i.created_at < now() - make_interval(days => ${wDays})`;
  // Open loop = not closed (Set aside included), the same set as the inbox.
  const isOpen = loopOpenSql(sql`i.status`);

  const [byStatusRows, byTypeRows, volRows, respRows, awaitingRows, trendRows, loopRows, openLoopRows, tierRows, themeRows, signals, anyRows] = await Promise.all([
    db.execute(sql`
      select i.status as status, count(*)::int as n from items i
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null and ${curW}
      group by i.status
    `),
    db.execute(sql`
      select i.type as type, count(*)::int as n from items i
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null and ${curW}
      group by i.type
    `),
    db.execute(sql`
      select count(*) filter (where ${curW})::int as cur,
             count(*) filter (where ${prevW})::int as prev
      from items i where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
    `),
    // Median time from submission to first vendor reply — current window vs prior.
    db.execute(sql`
      select
        coalesce(percentile_cont(0.5) within group (order by extract(epoch from (fr.first_reply - i.created_at))) filter (where ${curW}), 0)::float as cur,
        coalesce(percentile_cont(0.5) within group (order by extract(epoch from (fr.first_reply - i.created_at))) filter (where ${prevW}), 0)::float as prev,
        count(*) filter (where ${curW})::int as cur_n,
        count(*) filter (where ${prevW})::int as prev_n
      from items i
      join (
        select item_id, min(created_at) as first_reply
        from replies where workspace_user_id is not null and internal = false
        group by item_id
      ) fr on fr.item_id = i.id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
    `),
    // Open loops that have never had a vendor reply (snapshot — always "now").
    db.execute(sql`
      select count(*)::int as n from items i
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null and ${isOpen}
        and not exists (
          select 1 from replies r
          where r.item_id = i.id and r.workspace_user_id is not null and r.internal = false
        )
    `),
    // 12-week created trend (fixed momentum view; generate_series fills empty weeks).
    db.execute(sql`
      select to_char(wk, 'YYYY-MM-DD') as day, coalesce(c.n, 0)::int as n
      from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk
      left join (
        select date_trunc('week', created_at) as w, count(*) as n
        from items where workspace_id = ${ws}::uuid and merged_into_id is null
        group by 1
      ) c on c.w = wk
      order by wk
    `),
    // Loop time: submission → the customer hearing the outcome. Prefer the moment
    // we told them (customer_notifications ledger); fall back to the terminal
    // status event. Current window vs prior.
    db.execute(sql`
      select
        coalesce(percentile_cont(0.5) within group (order by extract(epoch from (coalesce(cn.first_told, se.at) - i.created_at))) filter (where ${curW}), 0)::float as cur,
        coalesce(percentile_cont(0.5) within group (order by extract(epoch from (coalesce(cn.first_told, se.at) - i.created_at))) filter (where ${prevW}), 0)::float as prev,
        count(*) filter (where ${curW})::int as cur_n,
        count(*) filter (where ${prevW})::int as prev_n
      from items i
      join (
        select item_id, min(at) as at from status_events
        where to_status in ('shipped','declined') group by item_id
      ) se on se.item_id = i.id
      left join (
        select item_id, min(sent_at) as first_told from customer_notifications
        where kind = 'status' and to_status in ('shipped','declined') group by item_id
      ) cn on cn.item_id = i.id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
    `),
    // Open loops + the combined ARR of the accounts they belong to (snapshot).
    db.execute(sql`
      with open_loops as (
        select i.id, i.account_id from items i
        where i.workspace_id = ${ws}::uuid
          and i.merged_into_id is null
          and ${isOpen}
      )
      select (select count(*)::int from open_loops) as n,
             coalesce((
               select sum(a.arr_cents)::bigint from accounts a
               where a.id in (select distinct account_id from open_loops)
             ), 0) as arr_cents
    `),
    // Volume by account ARR tier (windowed).
    db.execute(sql`
      select case
               when a.arr_cents >= 10000000 then 'enterprise'
               when a.arr_cents >= 1000000  then 'mid'
               when a.arr_cents > 0         then 'smb'
               else 'none'
             end as tier,
             count(*)::int as n
      from items i join accounts a on a.id = i.account_id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null and ${curW}
      group by 1
    `),
    // Top themes by initiative volume (windowed).
    db.execute(sql`
      select ini.name as name, count(*)::int as n
      from items i join initiatives ini on ini.id = i.initiative_id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null and ${curW}
      group by ini.name order by n desc limit 8
    `),
    accountRiskSignals(ws),
    // Any feedback at all, ever. None means a brand-new workspace (empty state).
    db.execute(sql`select exists (select 1 from items i where i.workspace_id = ${ws}::uuid) as found`),
  ]);

  const anyFeedback = (anyRows as unknown as Array<{ found: boolean }>)[0]?.found ?? false;
  const byStatus = byStatusRows as unknown as Array<{ status: string; n: number }>;
  const byType = byTypeRows as unknown as Array<{ type: string; n: number }>;
  const vol = (volRows as unknown as Array<{ cur: number; prev: number }>)[0] ?? { cur: 0, prev: 0 };
  const resp = (respRows as unknown as Array<{ cur: number; prev: number; cur_n: number; prev_n: number }>)[0] ?? { cur: 0, prev: 0, cur_n: 0, prev_n: 0 };
  const awaiting = (awaitingRows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  const trend = (trendRows as unknown as Array<{ day: string; n: number }>).map(r => ({ label: formatDate(r.day, { utc: true }), value: r.n }));
  const loop = (loopRows as unknown as Array<{ cur: number; prev: number; cur_n: number; prev_n: number }>)[0] ?? { cur: 0, prev: 0, cur_n: 0, prev_n: 0 };
  const openLoops = (openLoopRows as unknown as Array<{ n: number; arr_cents: number | string }>)[0] ?? { n: 0, arr_cents: 0 };
  const openLoopArr = Number(openLoops.arr_cents); // bigint sums arrive as strings from the driver

  const tierMap = new Map((tierRows as unknown as Array<{ tier: string; n: number }>).map(r => [r.tier, r.n]));
  const tierBars = TIER_ORDER.filter(t => (tierMap.get(t) ?? 0) > 0).map(t => ({ key: t, label: TIER_LABEL[t], n: tierMap.get(t) ?? 0 }));
  const tierTotal = tierBars.reduce((s, r) => s + r.n, 0);
  const themes = (themeRows as unknown as Array<{ name: string; n: number }>).map(r => ({ label: r.name, n: r.n }));

  const atRisk = atRiskAccounts(signals).slice(0, 8);
  const sentimentRiskArr = atRiskArrCents(signals);

  const statusCounts = new Map(byStatus.map(r => [r.status as Status, r.n]));
  const maxStatus = Math.max(1, ...byStatus.map(r => r.n));
  const statusTotal = byStatus.reduce((s, r) => s + r.n, 0);
  const typeTotal = byType.reduce((s, r) => s + r.n, 0);
  const trendTotal = trend.reduce((s, p) => s + p.value, 0);

  const loopDelta = durDelta(loop.cur, loop.prev, loop.cur_n, loop.prev_n, wDays);
  const respDelta = durDelta(resp.cur, resp.prev, resp.cur_n, resp.prev_n, wDays);
  const volDelta = wDays == null
    ? "total feedback"
    : vol.cur - vol.prev === 0
      ? `flat vs prior ${windowLabel}`
      : `${vol.cur - vol.prev > 0 ? "▲" : "▼"} ${Math.abs(vol.cur - vol.prev)} vs prior ${windowLabel}`;

  const head = (
    <PageHead
      crumb="Insights"
      title="Insights"
      lede="How fast you close loops, from a customer speaking up to hearing the outcome."
      actions={
        <>
          <div className="seg" role="group" aria-label="Time range">
            {RANGE_KEYS.map(k => (
              <Link key={k} href={k === DEFAULT_RANGE ? "/insights" : `/insights?range=${k}`} aria-current={k === rangeKey ? "page" : undefined} prefetch={false}>
                {RANGES[k].short}
              </Link>
            ))}
          </div>
          {/* Anchors styled as buttons — a <button> inside <a> is invalid HTML
              (causes a hydration mismatch), so use the .btn class directly. */}
          <a href="/qbr" target="_blank" rel="noreferrer" className="btn sm row gap-2 center" style={{ textDecoration: "none" }}>
            <Ic.doc style={{ width: 12, height: 12 }} /> QBR report
          </a>
          <a href="/insights/export" className="btn sm ghost row gap-2 center" style={{ textDecoration: "none" }}>
            <DownloadIc /> Export CSV
          </a>
        </>
      }
    />
  );

  // Nothing has ever come in: name the next step instead of a page of zeros.
  // (The .inbox-empty styles are the app's empty state.)
  if (!anyFeedback) {
    return (
      <>
        {head}
        <Card>
          <div className="inbox-empty">
            <p className="inbox-empty-head">Nothing to measure yet</p>
            <p className="inbox-empty-sub">
              Once customers send feedback, this page shows how fast you answer
              and close loops, and the ARR still waiting on you.
            </p>
            <Link href="/settings/install" className="inbox-empty-link">
              Install the widget <Ic.chevR style={{ width: 11, height: 11 }} />
            </Link>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      {head}

      {/* Hero — the page's thesis metric, given weight and a direction. */}
      <Card>
        <div className="card-body" style={{ padding: "22px 24px", display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 20 }}>
          <div className="col gap-2" style={{ minWidth: 0 }}>
            <span className="eyebrow">Median loop time</span>
            <div className="row center gap-3" style={{ flexWrap: "wrap" }}>
              <span className="serif" style={{ fontSize: 46, lineHeight: 1 }}>{humanDuration(loop.cur)}</span>
              {loopDelta && (
                <span
                  className="row center gap-1"
                  style={{
                    fontSize: 13, fontWeight: 500, padding: "3px 10px", borderRadius: 999,
                    background: loopDelta.tone === "good" ? "var(--green-soft)" : loopDelta.tone === "bad" ? "var(--rust-soft)" : "var(--surface-2)",
                    color: deltaTone(loopDelta.tone),
                  }}
                >
                  {loopDelta.arrow ? `${loopDelta.arrow} ` : ""}{loopDelta.mag ? `${loopDelta.mag} ` : ""}{loopDelta.word}
                </span>
              )}
            </div>
            <span className="text-xs muted">
              {loop.cur_n > 0 ? `across ${loop.cur_n} closed loop${loop.cur_n === 1 ? "" : "s"}` : "no closed loops yet"} · {scopedSub}
              {loopDelta ? ` vs prior ${windowLabel}` : ""}
            </span>
          </div>
          <p className="text-sm muted" style={{ margin: 0, maxWidth: 300, lineHeight: 1.5 }}>
            The time from a customer speaking up to hearing the outcome: shipped or declined. This is the loop.
          </p>
        </div>
      </Card>

      {/* Supporting KPIs */}
      <div className="kpi-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))", gap: 12 }}>
        <Kpi label="Open loops" value={String(openLoops.n)} sub={`${awaiting} still waiting on a first reply`} />
        <Kpi label="ARR at stake" value={formatArr(openLoopArr, "", "$0")} sub="accounts waiting on an answer" />
        <Kpi label="Median first response" value={humanDuration(resp.cur)} delta={deltaNode(respDelta)} sub={resp.cur_n > 0 ? `across ${resp.cur_n} answered · ${scopedSub}` : "none answered yet"} />
        <Kpi label={`New · ${scopedSub}`} value={String(vol.cur)} sub={volDelta} />
        {aiEntitled && <Kpi label="ARR at risk" value={formatArr(sentimentRiskArr, "", "$0")} sub="accounts trending negative · now" />}
      </div>

      <Card>
        <CardHead title="Feedback over time" after={<Pill ring>12 weeks</Pill>} />
        <div className="card-body" style={{ padding: 18 }}>
          {trendTotal === 0
            ? <p className="text-sm muted" style={{ margin: 0 }}>No feedback in the last 12 weeks yet. The trend appears once feedback comes in.</p>
            : <TrendChart points={trend} />}
        </div>
      </Card>

      {aiEntitled && atRisk.length > 0 && (
        <Card>
          <CardHead title="Accounts at risk" after={<Pill ring>{formatArr(sentimentRiskArr, " ARR")}</Pill>} />
          <div className="card-body col gap-2" style={{ padding: 18 }}>
            <p className="text-xs muted" style={{ margin: "0 0 6px" }}>High-ARR accounts trending negative on sentiment or with open severe issues. Highest revenue first.</p>
            {atRisk.map(a => (
              <Link key={a.accountId} href={`/accounts/${a.accountId}`} className="row gap-3 center between" style={{ textDecoration: "none", color: "inherit", padding: "6px 0", borderBottom: "1px solid var(--hair)" }}>
                <span className="row gap-2 center" style={{ minWidth: 0 }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: a.riskLevel === "high" ? "var(--rust)" : "var(--amber)", flexShrink: 0 }} />
                  <span className="text-xs" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500, color: a.riskLevel === "high" ? "var(--rust-deep)" : "var(--amber-deep)", flexShrink: 0 }}>{a.riskLevel}</span>
                  <span className="fw-med text-md truncate">{a.name}</span>
                </span>
                <span className="row gap-3 center text-xs muted" style={{ flexShrink: 0 }}>
                  <span className="mono">{formatArr(a.arrCents)}</span>
                  {a.sentimentTrend != null && <span style={{ color: a.sentimentTrend < 0 ? "var(--rust-deep)" : "var(--green-deep)" }}>{a.sentimentTrend < 0 ? "↓" : "↑"} {a.sentimentTrend.toFixed(2)}</span>}
                  {a.openCount > 0 && <span>{a.openCount} open</span>}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHead title="Status breakdown" after={<Pill ring>{statusTotal} {statusTotal === 1 ? "request" : "requests"} · {scopedSub}</Pill>} />
        <div className="card-body col gap-3" style={{ padding: 18 }}>
          {statusTotal === 0 ? (
            <p className="text-sm muted" style={{ margin: 0 }}>No feedback {wDays == null ? "yet" : `in the ${windowLabel}`}. Once feedback comes in, it breaks down by status here.</p>
          ) : (
            STATUS_ORDER.filter(s => (statusCounts.get(s) ?? 0) > 0).map(s => {
              const n = statusCounts.get(s) ?? 0;
              return (
                <div key={s} className="row gap-3 center">
                  <div style={{ width: 120, flexShrink: 0 }}><StatusPill status={s} /></div>
                  <div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${Math.round((n / maxStatus) * 100)}%`, height: "100%", background: STATUS_BAR_COLOR[s], borderRadius: 999 }} />
                  </div>
                  <span className="text-sm tabular" style={{ width: 36, textAlign: "right" }}>{n}</span>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <div className="cols-1-2" style={{ alignItems: "start" }}>
        <Card>
          <CardHead title="Volume by account tier" />
          <div className="card-body" style={{ padding: 18 }}>
            {tierTotal === 0 ? <span className="text-sm muted">No revenue-tagged feedback in this period.</span> : <TierStacked rows={tierBars} total={tierTotal} />}
          </div>
        </Card>
        <Card>
          <CardHead title="Top themes" />
          <div className="card-body" style={{ padding: 18 }}>
            {themes.length === 0
              ? <p className="text-sm muted" style={{ margin: 0 }}>Group requests into initiatives to see themes rank here.</p>
              : <BarList rows={themes} accentTop />}
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="By type" after={<Pill ring>{typeTotal} {typeTotal === 1 ? "request" : "requests"}</Pill>} />
        <div className="card-body row gap-6" style={{ padding: 18, flexWrap: "wrap" }}>
          {byType.length === 0 ? (
            <span className="text-sm muted">No feedback in this period.</span>
          ) : (
            byType.map(t => (
              <div key={t.type} className="col gap-1">
                <span className="serif" style={{ fontSize: 22, lineHeight: 1.1 }}>{t.n}</span>
                <span className="text-xs muted">{TYPE_LABEL[t.type] ?? t.type} · {Math.round((t.n / Math.max(1, typeTotal)) * 100)}%</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
