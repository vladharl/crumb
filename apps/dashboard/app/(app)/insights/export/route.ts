import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { accountRiskSignals } from "@/lib/insights/churn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function csv(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// QBR metrics export — one row per account with feedback counts, ARR (+ source),
// AI sentiment, and churn-risk level. Drives spreadsheet-based QBR prep.
export async function GET() {
  const { workspace } = await requireSession();
  const ws = workspace.id;

  const rows = (await db.execute(sql`
    select a.id as id, a.name as name, a.arr_cents as arr_cents, a.arr_source as arr_source,
      count(i.id) filter (where i.merged_into_id is null) as total,
      count(i.id) filter (where i.status in ('open','review','planned','progress')) as open,
      count(i.id) filter (where i.status = 'shipped') as shipped
    from accounts a left join items i on i.account_id = a.id
    where a.workspace_id = ${ws}::uuid
    group by a.id, a.name, a.arr_cents, a.arr_source
    order by a.arr_cents desc
  `)) as unknown as Array<{
    id: string; name: string; arr_cents: number | string; arr_source: string;
    total: number | string; open: number | string; shipped: number | string;
  }>;

  const signals = await accountRiskSignals(ws);
  const riskBy = new Map(signals.map(s => [s.accountId, s]));

  const lines = ["account_name,arr_usd,arr_source,total_feedback,open,shipped,avg_sentiment,risk_level"];
  for (const r of rows) {
    const risk = riskBy.get(r.id);
    lines.push([
      csv(r.name),
      String(Math.round(Number(r.arr_cents) / 100)),
      csv(r.arr_source ?? ""),
      String(Number(r.total)),
      String(Number(r.open)),
      String(Number(r.shipped)),
      risk?.avgSentiment != null ? risk.avgSentiment.toFixed(3) : "",
      risk?.riskLevel ?? "",
    ].join(","));
  }
  const body = lines.join("\n") + "\n";

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${workspace.slug}-qbr-metrics.csv"`,
    },
  });
}
