import { and, asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, inboundCaptures, accounts } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { CapturesList, type CaptureRow, type AccountOption } from "./CapturesList";

export async function CapturesTile() {
  const { workspace, user } = await getActiveSession();
  const sug = alias(accounts, "sug_acct");

  const rows = await db
    .select({
      id: inboundCaptures.id,
      source: inboundCaptures.source,
      fromEmail: inboundCaptures.fromEmail,
      fromName: inboundCaptures.fromName,
      subject: inboundCaptures.subject,
      body: inboundCaptures.body,
      suggestedAccountId: inboundCaptures.suggestedAccountId,
      suggestedAccountName: inboundCaptures.suggestedAccountName,
      suggestedConfidence: inboundCaptures.suggestedConfidence,
      createdAt: inboundCaptures.createdAt,
      sugName: sug.name,
    })
    .from(inboundCaptures)
    .leftJoin(sug, eq(sug.id, inboundCaptures.suggestedAccountId))
    .where(and(eq(inboundCaptures.workspaceId, workspace.id), eq(inboundCaptures.status, "pending")))
    .orderBy(desc(inboundCaptures.createdAt));

  const accountOptions: AccountOption[] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspace.id))
    .orderBy(asc(accounts.name));

  const captures: CaptureRow[] = rows.map((r) => ({
    id: r.id,
    source: r.source,
    fromEmail: r.fromEmail,
    fromName: r.fromName,
    subject: r.subject,
    body: r.body,
    suggestedAccountId: r.suggestedAccountId,
    // Prefer the live account name (join) over the denormalized snapshot.
    suggestedAccountName: r.sugName ?? r.suggestedAccountName,
    suggestedConfidence: r.suggestedConfidence,
    createdAtIso: r.createdAt.toISOString(),
  }));

  const canWrite = user.role === "admin" || user.role === "pm";
  return <CapturesList captures={captures} accounts={accountOptions} canWrite={canWrite} />;
}
