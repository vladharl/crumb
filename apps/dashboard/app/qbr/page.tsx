import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { hasFeature } from "@/lib/entitlements";
import { accountRiskSignals, atRiskAccounts, atRiskArrCents } from "@/lib/insights/churn";
import { loopOpenSql } from "@/lib/loop-sql";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "QBR" };

// Standalone, print-optimized Quarterly Business Review. Lives OUTSIDE the
// (app) group so it has no dashboard chrome — clean for "Cmd-P → Save as PDF".
// Covers the last 90 days. Reuses the same churn signals as Insights, and the
// same counting: unmerged items only, open = not closed (Set aside included).

function arr(cents: number): string {
  if (!cents) return "$0";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(2)}M`;
  if (cents >= 100_000) return `$${Math.round(cents / 100_000)}k`;
  return `$${Math.round(cents / 100)}`;
}
function humanDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export default async function QbrPage() {
  const { workspace } = await requireSession();
  const ws = workspace.id;
  const aiEntitled = hasFeature(workspace, "ai");

  const [portfolio, activity, closeRows, themeRows, topRows, signals] = await Promise.all([
    db.execute(sql`
      select coalesce(sum(arr_cents),0)::bigint as total_arr, count(*)::int as accounts
      from accounts where workspace_id = ${ws}::uuid
    `),
    db.execute(sql`
      select
        count(*) filter (where created_at >= now() - interval '90 days')::int as new_90,
        count(*) filter (where status = 'shipped' and updated_at >= now() - interval '90 days')::int as shipped_90,
        count(*) filter (where ${loopOpenSql(sql`status`)})::int as open_now
      from items where workspace_id = ${ws}::uuid and merged_into_id is null
    `),
    db.execute(sql`
      select coalesce(avg(extract(epoch from (se.at - i.created_at))),0)::float as avg_seconds, count(*)::int as closed
      from items i join (
        select item_id, min(at) as at from status_events where to_status in ('shipped','declined') group by item_id
      ) se on se.item_id = i.id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
    `),
    db.execute(sql`
      select ini.name as name, count(*)::int as n
      from items i join initiatives ini on ini.id = i.initiative_id
      where i.workspace_id = ${ws}::uuid and i.merged_into_id is null
      group by ini.name order by n desc limit 10
    `),
    db.execute(sql`
      select a.id as id, a.name as name, a.arr_cents as arr_cents,
        count(i.id) as total,
        count(i.id) filter (where ${loopOpenSql(sql`i.status`)}) as open,
        count(i.id) filter (where i.status = 'shipped') as shipped
      from accounts a left join items i on i.account_id = a.id and i.merged_into_id is null
      where a.workspace_id = ${ws}::uuid
      group by a.id, a.name, a.arr_cents
      order by a.arr_cents desc limit 15
    `),
    accountRiskSignals(ws),
  ]);

  const pf = (portfolio as unknown as Array<{ total_arr: number | string; accounts: number }>)[0] ?? { total_arr: 0, accounts: 0 };
  const act = (activity as unknown as Array<{ new_90: number; shipped_90: number; open_now: number }>)[0] ?? { new_90: 0, shipped_90: 0, open_now: 0 };
  const close = (closeRows as unknown as Array<{ avg_seconds: number; closed: number }>)[0] ?? { avg_seconds: 0, closed: 0 };
  const themes = themeRows as unknown as Array<{ name: string; n: number }>;
  const top = topRows as unknown as Array<{ id: string; name: string; arr_cents: number | string; total: number | string; open: number | string; shipped: number | string }>;
  const atRisk = atRiskAccounts(signals);
  const generated = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid var(--oat-deep)", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" };
  const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--hair-strong)", fontSize: 13 };

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 28px", color: "var(--oat-deep)", fontFamily: "var(--font-body, system-ui)" }}>
      <style>{`@media print { .no-print { display: none !important; } main { padding: 0 !important; } @page { margin: 16mm; } }`}</style>

      <div className="no-print" style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <Link href="/insights" style={{ color: "var(--accent-deep)", textDecoration: "none", fontSize: 13 }}>← Back to Insights</Link>
        <PrintButton />
      </div>

      <header style={{ borderBottom: "3px solid var(--oat-deep)", paddingBottom: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#8a8077" }}>Quarterly Business Review</div>
        <h1 style={{ fontSize: 30, margin: "4px 0 2px", fontWeight: 600 }}>{workspace.name}</h1>
        <div style={{ fontSize: 13, color: "#8a8077" }}>Last 90 days · generated {generated}</div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16, marginBottom: 28 }}>
        {[
          { label: "Total ARR", value: arr(Number(pf.total_arr)) },
          { label: "Accounts", value: String(pf.accounts) },
          { label: "New feedback", value: String(act.new_90) },
          { label: "Shipped", value: String(act.shipped_90) },
          { label: "Open now", value: String(act.open_now) },
          { label: "Avg time to close", value: humanDuration(close.avg_seconds) },
        ].map(k => (
          <div key={k.label}>
            <div style={{ fontSize: 26, fontWeight: 600 }}>{k.value}</div>
            <div style={{ fontSize: 12, color: "#8a8077" }}>{k.label}</div>
          </div>
        ))}
      </section>

      {aiEntitled && atRisk.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>Accounts at risk</h2>
          <div style={{ fontSize: 12, color: "#8a8077", marginBottom: 8 }}>
            Trending negative on sentiment or with open severe issues. {arr(atRiskArrCents(signals))} ARR.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Account</th><th style={th}>ARR</th><th style={th}>Sentiment</th><th style={th}>Trend</th><th style={th}>Open</th></tr></thead>
            <tbody>
              {atRisk.slice(0, 10).map(a => (
                <tr key={a.accountId}>
                  <td style={td}>{a.name}</td>
                  <td style={td}>{arr(a.arrCents)}</td>
                  <td style={td}>{a.avgSentiment != null ? a.avgSentiment.toFixed(2) : "—"}</td>
                  <td style={{ ...td, color: a.sentimentTrend != null && a.sentimentTrend < 0 ? "var(--rust)" : "var(--green)" }}>
                    {a.sentimentTrend != null ? `${a.sentimentTrend < 0 ? "↓" : "↑"} ${a.sentimentTrend.toFixed(2)}` : "—"}
                  </td>
                  <td style={td}>{a.openCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>Top accounts by revenue</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Account</th><th style={th}>ARR</th><th style={th}>Total</th><th style={th}>Open</th><th style={th}>Shipped</th></tr></thead>
          <tbody>
            {top.map(t => (
              <tr key={t.id}>
                <td style={td}>{t.name}</td>
                <td style={td}>{arr(Number(t.arr_cents))}</td>
                <td style={td}>{Number(t.total)}</td>
                <td style={td}>{Number(t.open)}</td>
                <td style={td}>{Number(t.shipped)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {themes.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>Top themes</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Theme</th><th style={th}>Items</th></tr></thead>
            <tbody>
              {themes.map(t => (
                <tr key={t.name}><td style={td}>{t.name}</td><td style={td}>{t.n}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer style={{ marginTop: 40, paddingTop: 12, borderTop: "1px solid var(--hair-strong)", fontSize: 11, color: "var(--mute-2)" }}>
        Generated by Crumb · {workspace.name} · {generated}
      </footer>
    </main>
  );
}
