import { Avatar, Card, CardHead, Pill, STATUS_LABELS } from "@crumb/ui";
import { db, accountUsers, items } from "@crumb/db";
import { and, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { notMergedSql } from "@/lib/loop-sql";
import { statusMix } from "@/lib/insights/status-mix";
import { UnblockButton } from "./UnblockButton";

// Both cards count unmerged items only, like the account hero. People blocked
// by Mark as spam come first: their spam was deleted, so they'd otherwise sink
// off the list, and their Unblock with them.
// ponytail: past 5 blocked people on one account, the rest only unblock in SQL.
async function loadRequesters(workspaceId: string, accountId: string) {
  return db
    .select({
      id: accountUsers.id,
      name: accountUsers.name,
      initials: accountUsers.initials,
      role: accountUsers.role,
      blockedAt: accountUsers.blockedAt,
      count: sql<number>`COUNT(${items.id})::int`,
    })
    .from(accountUsers)
    .leftJoin(items, and(eq(items.submitterId, accountUsers.id), notMergedSql(items.mergedIntoId)))
    .where(and(eq(accountUsers.workspaceId, workspaceId), eq(accountUsers.accountId, accountId)))
    .groupBy(accountUsers.id)
    .orderBy(sql`${accountUsers.blockedAt} IS NULL`, sql`COUNT(${items.id}) DESC`)
    .limit(5);
}

async function loadStatusMix(workspaceId: string, accountId: string) {
  const rows = await db
    .select({ status: items.status, count: sql<number>`COUNT(*)::int` })
    .from(items)
    .where(and(eq(items.workspaceId, workspaceId), eq(items.accountId, accountId), notMergedSql(items.mergedIntoId)))
    .groupBy(items.status);
  return statusMix(rows);
}

export async function AccountSidebarTile({ accountId }: { accountId: string }) {
  const { workspace, user } = await getActiveSession();
  const [requesters, stats] = await Promise.all([
    loadRequesters(workspace.id, accountId),
    loadStatusMix(workspace.id, accountId),
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
                <span className="row gap-2 center">
                  <span className="text-xs muted">{r.role === "admin" ? "Admin" : "Member"}</span>
                  {r.blockedAt && (
                    <Pill variant="rust" title="Marked as spam: their new feedback and email replies are turned away.">Blocked</Pill>
                  )}
                </span>
              </div>
              {r.blockedAt && user.role === "admin" && <UnblockButton accountUserId={r.id} name={r.name} />}
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
