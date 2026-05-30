import Link from "next/link";
import { Avatar, Card, Pill } from "@crumb/ui";
import { db, accounts } from "@crumb/db";
import { eq, sql } from "drizzle-orm";
import { getActiveWorkspace } from "@/lib/server";

// Account · ARR (bar + value) · Open · Shipped · Total · Since
const GRID = "1.5fr 220px 64px 70px 56px 76px";

// NOTE: correlated subqueries are written with fully table-qualified raw column
// refs (account_users.account_id = accounts.id). Interpolating drizzle column
// objects (`${accounts.id}`) renders them UNQUALIFIED ("id"), which silently
// resolves to the inner table and breaks the correlation (always 0).
async function loadAccounts(workspaceId: string) {
  const userCount = sql<number>`(
    SELECT COUNT(*)::int FROM account_users
    WHERE account_users.account_id = accounts.id
  )`.as("user_count");
  const openCount = sql<number>`(
    SELECT COUNT(*)::int FROM items
    WHERE items.account_id = accounts.id
      AND items.status IN ('open','review','planned','progress')
  )`.as("open_count");
  const shippedCount = sql<number>`(
    SELECT COUNT(*)::int FROM items
    WHERE items.account_id = accounts.id AND items.status = 'shipped'
  )`.as("shipped_count");
  const totalCount = sql<number>`(
    SELECT COUNT(*)::int FROM items WHERE items.account_id = accounts.id
  )`.as("total_count");
  // Open items with no vendor reply yet = awaiting first response. Drives the
  // "at-risk" signal (high-ARR accounts waiting on us).
  const awaitingCount = sql<number>`(
    SELECT COUNT(*)::int FROM items i
    WHERE i.account_id = accounts.id
      AND i.status IN ('open','review','planned','progress')
      AND NOT EXISTS (
        SELECT 1 FROM replies r
        WHERE r.item_id = i.id AND r.workspace_user_id IS NOT NULL
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

function arr(arrCents: number): string {
  if (arrCents === 0) return "—";
  if (arrCents >= 100_000_000) return `$${(arrCents / 100_000_000).toFixed(1)}M`;
  return `$${Math.round(arrCents / 100_000)}k`;
}

// Feedback health → a colored dot. Red when high-value work is waiting on us.
function health(openCount: number, awaitingCount: number): { color: string; label: string } {
  if (awaitingCount > 0) return { color: "var(--err-text)", label: `${awaitingCount} awaiting reply` };
  if (openCount > 0) return { color: "#C8881F", label: `${openCount} open` };
  return { color: "#4F7A52", label: "All addressed" };
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
  const rows = await loadAccounts(ws.id);

  const totalArr = rows.reduce((n, r) => n + r.arrCents, 0);
  const openArr = rows.reduce((n, r) => n + (r.openCount > 0 ? r.arrCents : 0), 0);
  const atRiskArr = rows.reduce((n, r) => n + (r.awaitingCount > 0 ? r.arrCents : 0), 0);
  const maxArr = rows.reduce((n, r) => Math.max(n, r.arrCents), 0) || 1;

  return (
    <>
      {/* Portfolio KPI header — revenue at a glance + what's at risk. */}
      <Card>
        <div className="card-body row gap-6" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <Kpi label="Total ARR" value={arr(totalArr)} />
          <Kpi label="Accounts" value={String(rows.length)} />
          <Kpi label="ARR with open feedback" value={arr(openArr)} />
          <Kpi label="At-risk ARR" value={arr(atRiskArr)} />
        </div>
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="list">
          <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
            <span>Account</span>
            <span>ARR</span>
            <span>Open</span>
            <span>Shipped</span>
            <span>Total</span>
            <span>Since</span>
          </div>
          {rows.map(r => {
            const h = health(r.openCount, r.awaitingCount);
            const pct = Math.max(2, Math.round((r.arrCents / maxArr) * 100));
            return (
              <Link
                key={r.id}
                href={`/accounts/${r.id}`}
                className="list-row"
                style={{ gridTemplateColumns: GRID }}
              >
                <div className="row gap-3 center" style={{ minWidth: 0 }}>
                  <Avatar kind="ink">{r.name[0]}</Avatar>
                  <div className="col" style={{ minWidth: 0 }}>
                    <span className="serif text-md truncate">{r.name}</span>
                    <span className="row gap-2 center text-xs muted" style={{ minWidth: 0 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: h.color, flexShrink: 0 }} title={h.label} />
                      <span className="truncate">{h.label} · {r.userCount} {r.userCount === 1 ? "user" : "users"}</span>
                    </span>
                  </div>
                </div>
                <div className="row gap-2 center" style={{ minWidth: 0 }}>
                  <div style={{ flex: 1, height: 6, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden", minWidth: 40 }}>
                    <div style={{ width: `${r.arrCents > 0 ? pct : 0}%`, height: "100%", background: "var(--accent)", borderRadius: 999 }} />
                  </div>
                  <span className="mono text-sm" style={{ width: 48, textAlign: "right", flexShrink: 0 }}>{arr(r.arrCents)}</span>
                </div>
                <span className="text-sm">{r.openCount > 0 ? <Pill ring ringFill>{r.openCount}</Pill> : <span className="muted-2">—</span>}</span>
                <span className="text-sm muted">{r.shippedCount}</span>
                <span className="text-xs muted">{r.totalCount}</span>
                <span className="text-xs muted">
                  {r.since ? new Date(r.since).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : "—"}
                </span>
              </Link>
            );
          })}
        </div>
      </Card>
    </>
  );
}
