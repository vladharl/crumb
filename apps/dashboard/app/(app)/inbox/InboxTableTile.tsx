import {
  db, items, accounts, accountUsers, workspaceUsers, replies as repliesTbl, initiatives, initiativeSuggestions,
} from "@crumb/db";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getActiveSession } from "@/lib/server";
import { clusterConfigured } from "@/lib/ai/cluster";
import { hasFeature } from "@/lib/entitlements";
import { InboxTable, type InboxRow, type Assignee, type InitiativeOption } from "./InboxTable";

async function loadItems(workspaceId: string): Promise<InboxRow[]> {
  const replyCount = sql<number>`(
    SELECT COUNT(*)::int FROM ${repliesTbl}
    WHERE ${repliesTbl.itemId} = ${items.id} AND ${repliesTbl.internal} = false
  )`.as("reply_count");

  // Suggested-initiative join: aliasing initiatives a second time so the
  // primary join (current assignment) and the secondary join (AI guess)
  // don't collide.
  const sugInit = alias(initiatives, "sug_init");

  const rows = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      status: items.status,
      assigneeId: items.assigneeId,
      createdAt: items.createdAt,
      accountName: accounts.name,
      submitterName: accountUsers.name,
      assigneeInitials: workspaceUsers.initials,
      replyCount,
      initiativeId: items.initiativeId,
      initiativeName: initiatives.name,
      initiativeColor: initiatives.color,
      suggestionId: initiativeSuggestions.id,
      suggestionInitiativeId: initiativeSuggestions.initiativeId,
      suggestionConfidence: initiativeSuggestions.confidence,
      suggestionReason: initiativeSuggestions.reason,
      suggestionInitiativeName: sugInit.name,
      suggestionInitiativeColor: sugInit.color,
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
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(items.createdAt));

  return rows.map(r => ({
    id: r.id,
    shortId: r.shortId,
    title: r.title,
    type: r.type,
    status: r.status,
    assigneeId: r.assigneeId,
    createdAtIso: r.createdAt.toISOString(),
    accountName: r.accountName,
    submitterName: r.submitterName,
    assigneeInitials: r.assigneeInitials,
    replyCount: r.replyCount,
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

async function loadAssignees(workspaceId: string): Promise<Assignee[]> {
  return db
    .select({ id: workspaceUsers.id, name: workspaceUsers.name, initials: workspaceUsers.initials })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.workspaceId, workspaceId))
    .orderBy(asc(workspaceUsers.name));
}

export async function InboxTableTile() {
  const { workspace, user: me } = await getActiveSession();
  const [rows, assignees, initiativeOptions] = await Promise.all([
    loadItems(workspace.id),
    loadAssignees(workspace.id),
    loadInitiativeOptions(workspace.id),
  ]);
  const canManageInitiatives = me.role === "admin" || me.role === "pm";
  // AI clustering is gated on the workspace's plan entitlement (cloud-only
  // by construction) — controls whether the "Cluster selected" UI shows.
  const aiEntitled = hasFeature(workspace, "ai");

  return (
    <InboxTable
      rows={rows}
      assignees={assignees}
      meId={me.id}
      aiEntitled={aiEntitled}
      initiatives={initiativeOptions}
      canManageInitiatives={canManageInitiatives}
      clusterEnabled={aiEntitled && clusterConfigured() && initiativeOptions.length > 0}
    />
  );
}
