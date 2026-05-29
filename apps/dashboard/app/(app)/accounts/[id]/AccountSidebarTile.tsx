import { Avatar, Card, CardHead } from "@crumb/ui";
import { db, accountUsers, items } from "@crumb/db";
import { eq, sql } from "drizzle-orm";

async function loadRequesters(accountId: string) {
  return db
    .select({
      id: accountUsers.id,
      name: accountUsers.name,
      initials: accountUsers.initials,
      role: accountUsers.role,
      count: sql<number>`COUNT(${items.id})::int`,
    })
    .from(accountUsers)
    .leftJoin(items, eq(items.submitterId, accountUsers.id))
    .where(eq(accountUsers.accountId, accountId))
    .groupBy(accountUsers.id)
    .orderBy(sql`COUNT(${items.id}) DESC`)
    .limit(5);
}

async function loadStatusMix(accountId: string) {
  const rows = await db
    .select({ status: items.status, count: sql<number>`COUNT(*)::int` })
    .from(items)
    .where(eq(items.accountId, accountId))
    .groupBy(items.status);
  const m = new Map(rows.map(r => [r.status, r.count]));
  const get = (s: string) => m.get(s) ?? 0;
  return {
    open: get("open") + get("review"),
    progress: get("planned") + get("progress"),
    shipped: get("shipped"),
    declined: get("declined"),
    deferred: get("deferred"),
  };
}

export async function AccountSidebarTile({ accountId }: { accountId: string }) {
  const [requesters, stats] = await Promise.all([
    loadRequesters(accountId),
    loadStatusMix(accountId),
  ]);

  return (
    <div className="col gap-4">
      <Card>
        <CardHead title="Top requesters" />
        <div className="card-body col gap-3">
          {requesters.length === 0 && (
            <span className="text-sm muted">No users yet from this account.</span>
          )}
          {requesters.map(r => (
            <div key={r.id} className="row gap-3 center">
              <Avatar size="sm">{r.initials}</Avatar>
              <div className="col grow">
                <span className="fw-med text-sm">{r.name}</span>
                <span className="text-xs muted">{r.role === "admin" ? "Admin" : "Member"}</span>
              </div>
              <span className="text-xs muted">{r.count} {r.count === 1 ? "item" : "items"}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead title="Status mix" />
        <div className="card-body col gap-2">
          {[
            ["Open / In review",  stats.open],
            ["Planned / In progress", stats.progress],
            ["Shipped",           stats.shipped],
            ["Won’t ship",        stats.declined],
            ["Set aside",         stats.deferred],
          ].map(([l, n]) => (
            <div key={l as string} className="row gap-3 center">
              <span className="text-sm grow">{l}</span>
              <span className="text-xs muted mono">{n as number}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
