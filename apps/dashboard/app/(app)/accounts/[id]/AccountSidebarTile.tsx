import { Avatar, Card, CardHead, STATUS_LABELS } from "@crumb/ui";
import { db, accountUsers, items } from "@crumb/db";
import { and, eq, sql } from "drizzle-orm";
import { notMergedSql } from "@/lib/loop-sql";
import { statusMix } from "@/lib/insights/status-mix";

// Both cards count unmerged items only, like the account hero.
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
    .leftJoin(items, and(eq(items.submitterId, accountUsers.id), notMergedSql(items.mergedIntoId)))
    .where(eq(accountUsers.accountId, accountId))
    .groupBy(accountUsers.id)
    .orderBy(sql`COUNT(${items.id}) DESC`)
    .limit(5);
}

async function loadStatusMix(accountId: string) {
  const rows = await db
    .select({ status: items.status, count: sql<number>`COUNT(*)::int` })
    .from(items)
    .where(and(eq(items.accountId, accountId), notMergedSql(items.mergedIntoId)))
    .groupBy(items.status);
  return statusMix(rows);
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
            [STATUS_LABELS.shipped,  stats.shipped],
            [STATUS_LABELS.declined, stats.declined],
            [STATUS_LABELS.deferred, stats.deferred],
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
