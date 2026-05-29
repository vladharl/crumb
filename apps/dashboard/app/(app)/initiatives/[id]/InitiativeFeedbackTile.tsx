import Link from "next/link";
import { Card, CardHead, StatusPill, TypeChip } from "@crumb/ui";
import type { Status, TypeKind } from "@crumb/ui";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { desc, eq } from "drizzle-orm";
import { ageFrom } from "@/lib/server";

const GRID = "64px 86px 1fr 140px 110px 90px 56px";

async function loadFeedback(initiativeId: string) {
  return db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      status: items.status,
      createdAt: items.createdAt,
      accountName: accounts.name,
      submitterName: accountUsers.name,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(eq(items.initiativeId, initiativeId))
    .orderBy(desc(items.updatedAt));
}

export async function InitiativeFeedbackTile({ id }: { id: string }) {
  const feedback = await loadFeedback(id);
  const total = feedback.length;

  return (
    <Card style={{ padding: 0 }}>
      <CardHead title={`Feedback · ${total}`} />
      <div className="list">
        {feedback.length === 0 && (
          <div className="card-body">
            <p className="text-sm muted" style={{ margin: 0 }}>
              No items grouped here yet. Set this initiative on items from the inbox or thread sidebar.
            </p>
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
            <span className="text-xs muted truncate">{it.accountName}</span>
            <StatusPill status={it.status as Status} />
            <span className="text-xs muted">{it.submitterName}</span>
            <span className="text-xs muted mono">{ageFrom(it.createdAt)}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
