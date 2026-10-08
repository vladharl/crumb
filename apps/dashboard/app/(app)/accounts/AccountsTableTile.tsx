import Link from "next/link";
import { Avatar, Card, Ic, Pill } from "@crumb/ui";
import { db, accounts } from "@crumb/db";
import { eq, sql } from "drizzle-orm";
import { getActiveWorkspace } from "@/lib/server";
import { hasFeature, usageAnalyticsAllowed } from "@/lib/entitlements";
import { accountRiskSignals, atRiskArrCents } from "@/lib/insights/churn";
import { loopOpenSql } from "@/lib/loop-sql";
import { formatArr } from "@/lib/priority";
import { formatMonth } from "@/lib/timefmt";
import { accountUsageSignals } from "@/lib/usage/signals";

// Account · ARR (bar + value) · Open · Shipped · Total · [Active] · Since
// The column tracks live in globals.css (`.accounts-row`) so a phone media
// query can reflow the row into a card without fighting an inline grid. The
// `--usage` variant adds the "Active" column when usage analytics is enabled.

// Compact "time since" for the Last active column — "3d", "2w", or "—".
function fmtActive(d: Date | null): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "now";
  const units: Array<[string, number]> = [
    ["w", 1000 * 60 * 60 * 24 * 7],
    ["d", 1000 * 60 * 60 * 24],
    ["h", 1000 * 60 * 60],
    ["m", 1000 * 60],
  ];
  for (const [u, mss] of units) if (ms >= mss) return `${Math.floor(ms / mss)}${u}`;
  return "now";
}

// NOTE: correlated subqueries are written with fully table-qualified raw column
// refs (account_users.account_id = accounts.id). Interpolating drizzle column
// objects (`${accounts.id}`) renders them UNQUALIFIED ("id"), which silently
// resolves to the inner table and breaks the correlation (always 0).
async function loadAccounts(workspaceId: string) {
  const userCount = sql<number>`(
    SELECT COUNT(*)::int FROM account_users
    WHERE account_users.account_id = accounts.id
  )`.as("user_count");
  // Item counts skip merged duplicates (each loop counts once). Open = not
  // closed, Set aside included: the same set as the inbox (lib/loop-sql).
  const openCount = sql<number>`(
    SELECT COUNT(*)::int FROM items
    WHERE items.account_id = accounts.id AND items.merged_into_id IS NULL
      AND ${loopOpenSql(sql`items.status`)}
  )`.as("open_count");
  const shippedCount = sql<number>`(
    SELECT COUNT(*)::int FROM items
    WHERE items.account_id = accounts.id AND items.merged_into_id IS NULL AND items.status = 'shipped'
  )`.as("shipped_count");
  const totalCount = sql<number>`(
    SELECT COUNT(*)::int FROM items WHERE items.account_id = accounts.id AND items.merged_into_id IS NULL
  )`.as("total_count");
  // Open loops with no vendor reply yet (internal notes don't count) =
  // awaiting first response. Drives the "at-risk" signal (high-ARR accounts
  // waiting on us).
  const awaitingCount = sql<number>`(
    SELECT COUNT(*)::int FROM items i
    WHERE i.account_id = accounts.id AND i.merged_into_id IS NULL
      AND ${loopOpenSql(sql`i.status`)}
      AND NOT EXISTS (
        SELECT 1 FROM replies r
        WHERE r.item_id = i.id AND r.internal = false AND r.workspace_user_id IS NOT NULL
      )
  )`.as("awaiting_count");

  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      arrCents: accounts.arrCents,
      since: accounts.since,
      userCount,
      openCount,
      shippedCount,
      totalCount,
      awaitingCount,
    })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId))
    .orderBy(sql`${accounts.arrCents} DESC`);
}

// Feedback health → a colored dot. Red when high-value work is waiting on us.
function health(openCount: number, awaitingCount: number): { color: string; label: string } {
  if (awaitingCount > 0) return { color: "var(--err-text)", label: `${awaitingCount} awaiting reply` };
  if (openCount > 0) return { color: "var(--amber)", label: `${openCount} open` };
  return { color: "var(--green)", label: "All addressed" };
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi" style={{ minWidth: 0 }}>
      <span className="num">{value}</span>
      <span className="lbl">{label}</span>
    </div>
  );
}

export async function AccountsTableTile() {
  const ws = await getActiveWorkspace();
  const aiEntitled = hasFeature(ws, "ai");
  const showUsage = usageAnalyticsAllowed(ws);
  const [rows, signals, usageByAccount] = await Promise.all([
    loadAccounts(ws.id),
    accountRiskSignals(ws.id),
    showUsage ? accountUsageSignals(ws.id) : Promise.resolve(new Map()),
  ]);

  // No accounts yet: point at the two ways they arrive, not a row of $0 KPIs
  // over a header-only table. (The .inbox-empty styles are the app's empty state.)
  if (rows.length === 0) {
    return (
      <Card>
        <div className="inbox-empty">
          <p className="inbox-empty-head">No accounts yet</p>
          <p className="inbox-empty-sub">
            Accounts show up as customers send feedback through the widget.
            Already have a customer list? Import it as a CSV.
          </p>
          <div className="row gap-5" style={{ flexWrap: "wrap", justifyContent: "center" }}>
            <Link href="/settings/install" className="inbox-empty-link">
              Install the widget <Ic.chevR style={{ width: 11, height: 11 }} />
            </Link>
            <Link href="/settings/account-mapping" className="inbox-empty-link">
              Import a CSV <Ic.chevR style={{ width: 11, height: 11 }} />
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  const riskByAccount = new Map(signals.map(s => [s.accountId, s]));
  // Only show the column if the workspace is entitled AND at least one account
  // has activity — otherwise it's a column of dashes.
  const hasUsage = showUsage && usageByAccount.size > 0;
  const usageClass = hasUsage ? " accounts-row--usage" : "";

  const totalArr = rows.reduce((n, r) => n + r.arrCents, 0);
  const openArr = rows.reduce((n, r) => n + (r.openCount > 0 ? r.arrCents : 0), 0);
  const atRiskArr = rows.reduce((n, r) => n + (r.awaitingCount > 0 ? r.arrCents : 0), 0);
  // Sentiment-based at-risk ARR (feature 6) — only meaningful when AI sentiment
  // is populated (Cloud + AI); hidden on self-host where it'd always be $0.
  const sentimentRiskArr = atRiskArrCents(signals);
  const maxArr = rows.reduce((n, r) => Math.max(n, r.arrCents), 0) || 1;

  return (
    <>
      {/* Portfolio KPI header — revenue at a glance + what's at risk. */}
      <Card>
        <div className="card-body row gap-6" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <Kpi label="Total ARR" value={formatArr(totalArr)} />
          <Kpi label="Accounts" value={String(rows.length)} />
          <Kpi label="ARR at stake" value={formatArr(openArr, "", "$0")} />
          <Kpi label="Awaiting-reply ARR" value={formatArr(atRiskArr, "", "$0")} />
          {aiEntitled && <Kpi label="Sentiment-risk ARR" value={formatArr(sentimentRiskArr, "", "$0")} />}
        </div>
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="list">
          <div className={`list-row head accounts-row${usageClass}`}>
            <span>Account</span>
            <span>ARR</span>
            <span>Open</span>
            <span>Shipped</span>
            <span>Total</span>
            {hasUsage && <span>Active</span>}
            <span>Since</span>
          </div>
          {rows.map(r => {
            const h = health(r.openCount, r.awaitingCount);
            const pct = Math.max(2, Math.round((r.arrCents / maxArr) * 100));
            const risk = riskByAccount.get(r.id);
            const showRisk = aiEntitled && risk && risk.riskLevel !== "low";
            return (
              <Link
                key={r.id}
                href={`/accounts/${r.id}`}
                className={`list-row accounts-row${usageClass}`}
              >
                <div className="acct-name row gap-3 center" style={{ minWidth: 0 }}>
                  <Avatar kind="ink">{r.name[0]}</Avatar>
                  <div className="col" style={{ minWidth: 0 }}>
                    <span className="row gap-2 center" style={{ minWidth: 0 }}>
                      <span className="fw-med text-md truncate">{r.name}</span>
                      {showRisk && (
                        <span
                          className="text-2xs fw-med"
                          title={`Sentiment ${risk!.avgSentiment?.toFixed(2) ?? "—"}${risk!.sentimentTrend != null ? ` · trend ${risk!.sentimentTrend > 0 ? "+" : ""}${risk!.sentimentTrend.toFixed(2)}` : ""}`}
                          style={{ color: risk!.riskLevel === "high" ? "var(--rust-deep)" : "var(--amber-deep)", flexShrink: 0 }}
                        >
                          {/* The level is in the words, not only the colour. */}
                          <span aria-hidden>↓</span> {risk!.riskLevel === "high" ? "high risk" : "at risk"}
                        </span>
                      )}
                    </span>
                    <span className="row gap-2 center text-xs muted" style={{ minWidth: 0 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: h.color, flexShrink: 0 }} title={h.label} />
                      <span className="truncate">{h.label} · {r.userCount} {r.userCount === 1 ? "user" : "users"}</span>
                    </span>
                  </div>
                </div>
                <div className="acct-arr row gap-2 center" style={{ minWidth: 0 }}>
                  <div style={{ flex: 1, height: 6, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden", minWidth: 40 }}>
                    <div style={{ width: `${r.arrCents > 0 ? pct : 0}%`, height: "100%", background: "var(--brown-65)", borderRadius: 999 }} />
                  </div>
                  <span className={r.arrCents > 0 ? "mono text-sm" : "text-xs muted"} style={{ minWidth: 48, textAlign: "right", flexShrink: 0 }}>{formatArr(r.arrCents)}</span>
                </div>
                <span className="acct-open text-sm">{r.openCount > 0 ? <Pill ring ringFill>{r.openCount}</Pill> : <span className="muted-2">—</span>}</span>
                <span className="acct-shipped text-sm muted">{r.shippedCount}</span>
                <span className="acct-total text-xs muted">{r.totalCount}</span>
                {hasUsage && (
                  <span className="acct-active text-xs muted" title="Last product activity">
                    {fmtActive(usageByAccount.get(r.id)?.lastActiveAt ?? null)}
                  </span>
                )}
                <span className="acct-since text-xs muted">
                  {r.since ? formatMonth(r.since) : "—"}
                </span>
              </Link>
            );
          })}
        </div>
      </Card>
    </>
  );
}
