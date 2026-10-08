import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar, Card, PageHead, Pill, STATUS_LABELS } from "@crumb/ui";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { and, eq, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { notMergedSql } from "@/lib/loop-sql";
import { statusMix } from "@/lib/insights/status-mix";
import { formatMonth } from "@/lib/timefmt";
import { AccountArrEdit } from "./AccountArrEdit";

async function loadHero(workspaceId: string, accountId: string) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
    .limit(1);
  if (!account) return null;

  const [statsRows, [{ count: requesterCount }]] = await Promise.all([
    db
      .select({ status: items.status, count: sql<number>`COUNT(*)::int` })
      .from(items)
      .where(and(eq(items.accountId, accountId), notMergedSql(items.mergedIntoId)))
      .groupBy(items.status),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(accountUsers)
      .where(eq(accountUsers.accountId, accountId)),
  ]);

  return { account, stats: statusMix(statsRows), requesterCount };
}

export async function AccountHeroTile({ accountId }: { accountId: string }) {
  const { workspace: ws, user } = await getActiveSession();
  const data = await loadHero(ws.id, accountId);
  if (!data) notFound();
  const { account, stats, requesterCount } = data;
  const canEdit = user.role === "admin" || user.role === "pm";
  const sinceLabel = account.since ? formatMonth(account.since) : "—";

  return (
    <>
      <PageHead
        crumb={<Link href="/accounts" style={{ color: "inherit" }}>Accounts</Link>}
        title={account.name}
        lede="Everything they've submitted, replied to, and seen ship. The view to open before every QBR."
      />

      <Card>
        <div className="card-body row gap-5" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <Avatar kind="ink" size="xl">{account.name[0]}</Avatar>
          <div className="col gap-2 grow" style={{ minWidth: 220 }}>
            <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
              <span className="serif" style={{ fontSize: 32, lineHeight: 1.1 }}>{account.name}</span>
              <AccountArrEdit accountId={account.id} arrCents={account.arrCents} canEdit={canEdit} />
              {account.since && <Pill>since {sinceLabel}</Pill>}
            </div>
            <div className="text-sm muted">
              {requesterCount} {requesterCount === 1 ? "person" : "people"} have submitted feedback so far.
            </div>
          </div>
          <div className="row gap-6" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            {[
              [String(stats.open),     "Open"],
              [String(stats.progress), "In progress"],
              [String(stats.shipped),  STATUS_LABELS.shipped],
              [String(stats.declined), STATUS_LABELS.declined],
              [String(stats.deferred), STATUS_LABELS.deferred],
            ].map(([n, l]) => (
              <div key={l} className="kpi" style={{ alignItems: "center" }}>
                <span className="num">{n}</span>
                <span className="lbl">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
