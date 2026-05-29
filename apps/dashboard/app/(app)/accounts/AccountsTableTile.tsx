import Link from "next/link";
import { Avatar, Card, Pill } from "@crumb/ui";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { eq, sql } from "drizzle-orm";
import { getActiveWorkspace } from "@/lib/server";

const GRID = "1.4fr 80px 80px 80px 60px 60px 80px";

async function loadAccounts(workspaceId: string) {
  const userCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${accountUsers}
    WHERE ${accountUsers.accountId} = ${accounts.id}
  )`.as("user_count");
  const openCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${items}
    WHERE ${items.accountId} = ${accounts.id}
      AND ${items.status} IN ('open','review','planned','progress')
  )`.as("open_count");
  const shippedCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${items}
    WHERE ${items.accountId} = ${accounts.id}
      AND ${items.status} = 'shipped'
  )`.as("shipped_count");
  const totalCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${items}
    WHERE ${items.accountId} = ${accounts.id}
  )`.as("total_count");

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

export async function AccountsTableTile() {
  const ws = await getActiveWorkspace();
  const rows = await loadAccounts(ws.id);

  return (
    <Card style={{ padding: 0 }}>
      <div className="list">
        <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
          <span>Account</span>
          <span>ARR</span>
          <span>Users</span>
          <span>Open</span>
          <span>Shipped</span>
          <span>Total</span>
          <span>Since</span>
        </div>
        {rows.map(r => (
          <Link
            key={r.id}
            href={`/accounts/${r.id}`}
            className="list-row"
            style={{ gridTemplateColumns: GRID }}
          >
            <div className="row gap-3 center">
              <Avatar kind="ink">{r.name[0]}</Avatar>
              <div className="col">
                <span className="serif text-md">{r.name}</span>
                <span className="text-xs muted">{r.userCount} {r.userCount === 1 ? "user" : "users"}</span>
              </div>
            </div>
            <span className="mono text-sm">{arr(r.arrCents)}</span>
            <span className="text-sm muted">{r.userCount}</span>
            <span className="text-sm">{r.openCount > 0 ? <Pill ring ringFill>{r.openCount}</Pill> : <span className="muted-2">—</span>}</span>
            <span className="text-sm muted">{r.shippedCount}</span>
            <span className="text-xs muted">{r.totalCount}</span>
            <span className="text-xs muted">
              {r.since ? new Date(r.since).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : "—"}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
