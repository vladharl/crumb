import Link from "next/link";
import { Card, CardHead, Ic, StatusPill, TypeChip } from "@crumb/ui";
import type { Status, TypeKind } from "@crumb/ui";
import { db, accountUsers, items, initiatives } from "@crumb/db";
import { and, count, desc, eq } from "drizzle-orm";
import { ageFrom, getActiveSession } from "@/lib/server";
import { InitiativeChip } from "../../initiatives/InitiativeChip";

const GRID = "64px 86px 1fr 120px 110px 90px 56px";

// The newest few; the inbox, filtered to the account, has the rest.
const SHOWN = 20;

async function loadFeedback(workspaceId: string, accountId: string) {
  const where = and(eq(items.workspaceId, workspaceId), eq(items.accountId, accountId));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: items.id,
        shortId: items.shortId,
        title: items.title,
        type: items.type,
        status: items.status,
        createdAt: items.createdAt,
        submitterName: accountUsers.name,
        initiativeId: items.initiativeId,
        initiativeName: initiatives.name,
        initiativeColor: initiatives.color,
      })
      .from(items)
      .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
      .leftJoin(initiatives, eq(initiatives.id, items.initiativeId))
      .where(where)
      .orderBy(desc(items.createdAt))
      .limit(SHOWN),
    db.select({ total: count() }).from(items).where(where),
  ]);
  return { rows, total };
}

export async function AccountFeedbackTile({ accountId }: { accountId: string }) {
  const { workspace } = await getActiveSession();
  const { rows: feedback, total } = await loadFeedback(workspace.id, accountId);

  return (
    <Card>
      <CardHead
        title={`All feedback · ${total}`}
        after={total > 0 && (
          <Link href={`/inbox?tab=all&account=${accountId}`} className="rd-openthread">
            {/* No count here: the inbox folds merged duplicates under their item. */}
            {total > SHOWN ? "View all in inbox" : "View in inbox"}
            <Ic.chevR style={{ width: 11, height: 11 }} />
          </Link>
        )}
      />
      <div className="list embed-stack">
        {feedback.length === 0 && (
          <div className="card-body">
            <p className="text-sm muted" style={{ margin: 0 }}>No feedback yet.</p>
          </div>
        )}
        {feedback.map(it => (
          <Link
            key={it.id}
            href={`/thread/${it.shortId}`}
            className="list-row"
            style={{ gridTemplateColumns: GRID }}
          >
            <span className="text-2xs mono muted">{it.shortId}</span>
            <span><TypeChip type={it.type as TypeKind} /></span>
            <span className="fw-med truncate">{it.title}</span>
            <span style={{ minWidth: 0 }}>
              <InitiativeChip
                initiative={it.initiativeId ? {
                  id: it.initiativeId,
                  shortId: "",
                  name: it.initiativeName ?? "",
                  color: it.initiativeColor,
                  status: "",
                } : null}
              />
            </span>
            <StatusPill status={it.status as Status} />
            <span className="text-xs muted">{it.submitterName}</span>
            <span className="text-xs muted mono">{ageFrom(it.createdAt)}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
