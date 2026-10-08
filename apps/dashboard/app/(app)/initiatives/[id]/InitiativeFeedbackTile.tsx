import Link from "next/link";
import { Card, CardHead, StatusPill, TypeChip } from "@crumb/ui";
import type { Status, TypeKind } from "@crumb/ui";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { and, desc, eq } from "drizzle-orm";
import { notMergedSql } from "@/lib/loop-sql";
import { ageFrom, getActiveSession } from "@/lib/server";
import { AddItemsButton } from "./AddItemsButton";

const GRID = "64px 86px 1fr 140px 110px 90px 56px";

// Merged duplicates are left out, as in the header's count: the inbox folds
// them under the request they were merged into.
async function loadFeedback(workspaceId: string, initiativeId: string) {
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
    .where(and(eq(items.workspaceId, workspaceId), eq(items.initiativeId, initiativeId), notMergedSql(items.mergedIntoId)))
    .orderBy(desc(items.updatedAt));
}

export async function InitiativeFeedbackTile({ id }: { id: string }) {
  const { workspace, user } = await getActiveSession();
  const feedback = await loadFeedback(workspace.id, id);
  const total = feedback.length;
  const canManage = user.role === "admin" || user.role === "pm";

  return (
    <Card style={{ padding: 0 }}>
      <CardHead title={`Feedback · ${total}`} after={canManage ? <AddItemsButton initiativeId={id} /> : null} />
      <div className="list embed-stack">
        {feedback.length === 0 && (
          <div className="card-body">
            <p className="text-sm muted" style={{ margin: 0 }}>
              No requests grouped here yet. Use <strong style={{ fontWeight: 600 }}>Add requests</strong> above, or set this initiative from the inbox or a thread sidebar.
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
