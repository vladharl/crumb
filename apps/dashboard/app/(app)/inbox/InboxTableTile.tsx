import {
  db, items, accounts, accountUsers, workspaceUsers, initiatives, initiativeSuggestions, inboundCaptures,
} from "@crumb/db";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getActiveSession } from "@/lib/server";
import { clusterConfigured } from "@/lib/ai/cluster";
import { hasFeature } from "@/lib/entitlements";
import { InboxTable, type InboxRow, type Assignee, type InitiativeOption } from "./InboxTable";
import { CaptureTriage } from "./CaptureTriage";
import type { CaptureRow, AccountOption } from "../captures/CapturesList";

async function loadItems(workspaceId: string): Promise<InboxRow[]> {
  // Fully-qualified raw refs, NOT ${items.id}/${repliesTbl.*}: inside a raw
  // subquery template drizzle renders interpolated columns unqualified, so
  // ${items.id} -> "id" resolves to replies.id (the inner table's own id)
  // instead of the outer item — silently making every reply count 0.
  const replyCount = sql<number>`(
    SELECT COUNT(*)::int FROM replies
    WHERE replies.item_id = items.id AND replies.internal = false
  )`.as("reply_count");

  // Whose turn is it: the side of the most recent non-internal reply. Vendor
  // replied last -> the loop is waiting on the customer; customer replied last
  // (or nobody has) -> the loop is on you. Derivation lives in lib/loop.ts.
  const lastReplySide = sql<"vendor" | "customer" | null>`(
    SELECT CASE WHEN r.workspace_user_id IS NOT NULL THEN 'vendor' ELSE 'customer' END
    FROM replies r
    WHERE r.item_id = items.id AND r.internal = false
    ORDER BY r.created_at DESC
    LIMIT 1
  )`.as("last_reply_side");

  // Epoch ms (double precision -> JS number) of the latest non-internal reply,
  // so "waiting since" doesn't depend on driver timestamp parsing inside a raw
  // subquery.
  const lastExternalReplyMs = sql<number | null>`(
    SELECT (EXTRACT(EPOCH FROM MAX(r.created_at)) * 1000)::double precision
    FROM replies r
    WHERE r.item_id = items.id AND r.internal = false
  )`.as("last_external_reply_ms");

  // Whether a vendor has ever answered (lights the trail's "Answered" crumb —
  // lastReplySide alone can't tell, since a later customer reply masks it).
  const vendorReplied = sql<boolean>`EXISTS (
    SELECT 1 FROM replies r
    WHERE r.item_id = items.id AND r.internal = false AND r.workspace_user_id IS NOT NULL
  )`.as("vendor_replied");

  // One-line inbox preview: the AI summary when triage produced one, else a
  // whitespace-collapsed snippet of the body. LEFT(…, 141) caps it in SQL so
  // full bodies never ship to the client; the mapper turns char 141 into "…".
  // ('\\s' because a single backslash in this template degrades to plain "s".)
  const preview = sql<string | null>`
    NULLIF(LEFT(regexp_replace(COALESCE(items.ai_summary, items.body), '\\s+', ' ', 'g'), 141), '')
  `.as("preview");

  // Suggested-initiative join: aliasing initiatives a second time so the
  // primary join (current assignment) and the secondary join (AI guess)
  // don't collide.
  const sugInit = alias(initiatives, "sug_init");
  // Suggested-assignee join (AI triage): a second alias of workspace_users so
  // it doesn't collide with the current-assignee join above.
  const aiAsg = alias(workspaceUsers, "ai_asg");
  // Count of duplicates folded into this item (feature 4). Fully-qualified raw
  // refs for the same reason as reply_count above.
  const mergedCount = sql<number>`(
    SELECT COUNT(*)::int FROM items dups
    WHERE dups.merged_into_id = items.id
  )`.as("merged_count");

  const rows = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      preview,
      type: items.type,
      status: items.status,
      assigneeId: items.assigneeId,
      createdAt: items.createdAt,
      accountName: accounts.name,
      submitterName: accountUsers.name,
      assigneeInitials: workspaceUsers.initials,
      replyCount,
      lastReplySide,
      lastExternalReplyMs,
      vendorReplied,
      initiativeId: items.initiativeId,
      initiativeName: initiatives.name,
      initiativeColor: initiatives.color,
      suggestionId: initiativeSuggestions.id,
      suggestionInitiativeId: initiativeSuggestions.initiativeId,
      suggestionConfidence: initiativeSuggestions.confidence,
      suggestionReason: initiativeSuggestions.reason,
      suggestionInitiativeName: sugInit.name,
      suggestionInitiativeColor: sugInit.color,
      // AI triage (feature 3)
      aiSeverity: items.aiSeverity,
      aiSentiment: items.aiSentiment,
      aiTriageReason: items.aiTriageReason,
      aiSuggestedAssigneeId: items.aiSuggestedAssigneeId,
      aiSuggestedAssigneeInitials: aiAsg.initials,
      aiSuggestedAssigneeName: aiAsg.name,
      // Merge (feature 4)
      mergedIntoId: items.mergedIntoId,
      mergedCount,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, items.assigneeId))
    .leftJoin(initiatives, eq(initiatives.id, items.initiativeId))
    .leftJoin(initiativeSuggestions, and(
      eq(initiativeSuggestions.itemId, items.id),
      eq(initiativeSuggestions.status, "pending"),
    ))
    .leftJoin(sugInit, eq(sugInit.id, initiativeSuggestions.initiativeId))
    .leftJoin(aiAsg, eq(aiAsg.id, items.aiSuggestedAssigneeId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(items.createdAt));

  return rows.map(r => ({
    id: r.id,
    shortId: r.shortId,
    title: r.title,
    preview: r.preview === null ? null : r.preview.length > 140 ? r.preview.slice(0, 140).trimEnd() + "…" : r.preview,
    type: r.type,
    status: r.status,
    assigneeId: r.assigneeId,
    createdAtIso: r.createdAt.toISOString(),
    accountName: r.accountName,
    submitterName: r.submitterName,
    assigneeInitials: r.assigneeInitials,
    replyCount: r.replyCount,
    lastReplySide: r.lastReplySide,
    lastExternalReplyAtIso: r.lastExternalReplyMs === null ? null : new Date(r.lastExternalReplyMs).toISOString(),
    vendorReplied: r.vendorReplied,
    initiativeId: r.initiativeId,
    initiativeName: r.initiativeName,
    initiativeColor: r.initiativeColor,
    suggestion: r.suggestionId && r.suggestionInitiativeId ? {
      id: r.suggestionId,
      initiativeId: r.suggestionInitiativeId,
      initiativeName: r.suggestionInitiativeName ?? "",
      initiativeColor: r.suggestionInitiativeColor,
      confidence: r.suggestionConfidence ?? 0,
      reason: r.suggestionReason,
    } : null,
    aiSeverity: r.aiSeverity,
    aiSentiment: r.aiSentiment,
    aiTriageReason: r.aiTriageReason,
    aiSuggestedAssignee: r.aiSuggestedAssigneeId && r.aiSuggestedAssigneeInitials ? {
      id: r.aiSuggestedAssigneeId,
      initials: r.aiSuggestedAssigneeInitials,
      name: r.aiSuggestedAssigneeName ?? "",
    } : null,
    mergedIntoId: r.mergedIntoId,
    mergedCount: r.mergedCount,
  }));
}

async function loadInitiativeOptions(workspaceId: string): Promise<InitiativeOption[]> {
  return db
    .select({
      id: initiatives.id,
      name: initiatives.name,
      color: initiatives.color,
      status: initiatives.status,
    })
    .from(initiatives)
    .where(and(eq(initiatives.workspaceId, workspaceId), ne(initiatives.status, "parked")))
    .orderBy(asc(initiatives.name));
}

// Pending captures (forwarded feedback awaiting account mapping) surfaced at the
// top of the Inbox. Lifted from the retired Captures page's tile query.
async function loadPendingCaptures(workspaceId: string): Promise<{ captures: CaptureRow[]; accountOptions: AccountOption[] }> {
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
    .where(and(eq(inboundCaptures.workspaceId, workspaceId), eq(inboundCaptures.status, "pending")))
    .orderBy(desc(inboundCaptures.createdAt));

  const accountOptions: AccountOption[] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId))
    .orderBy(asc(accounts.name));

  const captures: CaptureRow[] = rows.map(r => ({
    id: r.id,
    source: r.source,
    fromEmail: r.fromEmail,
    fromName: r.fromName,
    subject: r.subject,
    body: r.body,
    suggestedAccountId: r.suggestedAccountId,
    suggestedAccountName: r.sugName ?? r.suggestedAccountName,
    suggestedConfidence: r.suggestedConfidence,
    createdAtIso: r.createdAt.toISOString(),
  }));

  return { captures, accountOptions };
}

async function loadAssignees(workspaceId: string): Promise<Assignee[]> {
  return db
    .select({ id: workspaceUsers.id, name: workspaceUsers.name, initials: workspaceUsers.initials })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.workspaceId, workspaceId))
    .orderBy(asc(workspaceUsers.name));
}

export async function InboxTableTile() {
  const { workspace, user: me } = await getActiveSession();
  const [rows, assignees, initiativeOptions, captureData] = await Promise.all([
    loadItems(workspace.id),
    loadAssignees(workspace.id),
    loadInitiativeOptions(workspace.id),
    loadPendingCaptures(workspace.id),
  ]);
  const canManageInitiatives = me.role === "admin" || me.role === "pm";
  // Viewers are read-only — gates the bulk status/assign bar. (Same expr as
  // canManageInitiatives today, but kept distinct for clarity of intent.)
  const canWrite = me.role === "admin" || me.role === "pm";
  // AI clustering is gated on the workspace's plan entitlement (cloud-only
  // by construction) — controls whether the "Cluster selected" UI shows.
  const aiEntitled = hasFeature(workspace, "ai");

  return (
    <>
      <CaptureTriage captures={captureData.captures} accounts={captureData.accountOptions} canWrite={canWrite} />
      <InboxTable
        rows={rows}
        assignees={assignees}
        meId={me.id}
        canWrite={canWrite}
        aiEntitled={aiEntitled}
        initiatives={initiativeOptions}
        canManageInitiatives={canManageInitiatives}
        clusterEnabled={aiEntitled && clusterConfigured() && initiativeOptions.length > 0}
      />
    </>
  );
}
