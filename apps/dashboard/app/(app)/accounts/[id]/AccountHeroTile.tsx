import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar, Card, PageHead, Pill } from "@crumb/ui";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { and, eq, sql } from "drizzle-orm";
import { getActiveWorkspace } from "@/lib/server";

function arr(arrCents: number): string {
  if (arrCents === 0) return "—";
  if (arrCents >= 100_000_000) return `$${(arrCents / 100_000_000).toFixed(1)}M ARR`;
  return `$${Math.round(arrCents / 100_000)}k ARR`;
}

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
      .where(eq(items.accountId, accountId))
      .groupBy(items.status),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(accountUsers)
      .where(eq(accountUsers.accountId, accountId)),
  ]);

  const m = new Map(statsRows.map(r => [r.status, r.count]));
  const get = (s: string) => m.get(s) ?? 0;
  const stats = {
    open: get("open") + get("review"),
    progress: get("planned") + get("progress"),
    shipped: get("shipped"),
    declined: get("declined"),
    deferred: get("deferred"),
  };

  return { account, stats, requesterCount };
}

export async function AccountHeroTile({ accountId }: { accountId: string }) {
  const ws = await getActiveWorkspace();
  const data = await loadHero(ws.id, accountId);
  if (!data) notFound();
  const { account, stats, requesterCount } = data;
  const sinceLabel = account.since
    ? new Date(account.since).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
    : "—";

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
              <Pill solid>{arr(account.arrCents)}</Pill>
              {account.since && <Pill>since {sinceLabel}</Pill>}
            </div>
            <div className="text-sm muted">
              {requesterCount} {requesterCount === 1 ? "person" : "people"} have submitted feedback so far.
            </div>
          </div>
          <div className="row gap-6" style={{ alignItems: "flex-end" }}>
            {[
              [String(stats.open),     "Open"],
              [String(stats.progress), "In progress"],
              [String(stats.shipped),  "Shipped"],
              [String(stats.declined + stats.deferred), "Won’t ship"],
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
