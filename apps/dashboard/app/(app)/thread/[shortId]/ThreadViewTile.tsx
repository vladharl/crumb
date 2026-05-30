import { notFound } from "next/navigation";
import { db, items, accounts, accountUsers, workspaceUsers, replies, statusEvents, attachments, initiatives, initiativeSuggestions } from "@crumb/db";
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { ticketSuggestionConfigured } from "@/lib/ai/ticket";
import { getReplayForItem } from "@/lib/replay/read";
import { hasFeature } from "@/lib/entitlements";
import { ThreadView, type ThreadData } from "./ThreadView";

type WorkspaceForThread = {
  id: string;
  linearInstalledAt: Date | null;
  jiraInstalledAt: Date | null;
  githubInstalledAt: Date | null;
  // Billing columns drive the AI entitlement check below. The full session
  // workspace row carries these; the type just narrows what loadThread uses.
  planId: string;
  subscriptionStatus: string | null;
};

async function loadThread(workspace: WorkspaceForThread, shortId: string, canManageInitiatives: boolean): Promise<ThreadData | null> {
  const workspaceId = workspace.id;
  const [head] = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      body: items.body,
      type: items.type,
      status: items.status,
      createdAt: items.createdAt,
      accountId: items.accountId,
      accountName: accounts.name,
      accountArr: accounts.arrCents,
      submitterId: items.submitterId,
      submitterName: accountUsers.name,
      submitterInitials: accountUsers.initials,
      assigneeInitials: workspaceUsers.initials,
      assigneeName: workspaceUsers.name,
      externalProvider: items.externalProvider,
      externalTicketId: items.externalTicketId,
      externalTicketUrl: items.externalTicketUrl,
      externalStatus: items.externalStatus,
      externalSyncedAt: items.externalSyncedAt,
      initiativeId: items.initiativeId,
      initiativeName: initiatives.name,
      initiativeColor: initiatives.color,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, items.assigneeId))
    .leftJoin(initiatives, eq(initiatives.id, items.initiativeId))
    .where(and(eq(items.workspaceId, workspaceId), eq(items.shortId, shortId)))
    .limit(1);

  if (!head) return null;

  const wsAuthor = await db
    .select({ id: workspaceUsers.id, name: workspaceUsers.name, initials: workspaceUsers.initials })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.workspaceId, workspaceId));
  const wsAuthorById = Object.fromEntries(wsAuthor.map(u => [u.id, u]));

  const acctAuthor = await db
    .select({ id: accountUsers.id, name: accountUsers.name, initials: accountUsers.initials })
    .from(accountUsers)
    .where(eq(accountUsers.workspaceId, workspaceId));
  const acctAuthorById = Object.fromEntries(acctAuthor.map(u => [u.id, u]));

  const rows = await db
    .select()
    .from(replies)
    .where(eq(replies.itemId, head.id))
    .orderBy(asc(replies.createdAt));

  const replyIds = rows.map(r => r.id);
  const attachmentRows = replyIds.length === 0 ? [] : await db
    .select({
      id: attachments.id,
      replyId: attachments.replyId,
      filename: attachments.filename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(and(inArray(attachments.replyId, replyIds), isNotNull(attachments.replyId)));
  const attachmentsByReply = new Map<string, typeof attachmentRows>();
  for (const a of attachmentRows) {
    if (!a.replyId) continue;
    const arr = attachmentsByReply.get(a.replyId) ?? [];
    arr.push(a);
    attachmentsByReply.set(a.replyId, arr);
  }

  const messages = rows.map(r => {
    const atts = (attachmentsByReply.get(r.id) ?? []).map(a => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));
    if (r.workspaceUserId && wsAuthorById[r.workspaceUserId]) {
      const u = wsAuthorById[r.workspaceUserId]!;
      return {
        id: r.id, kind: "vendor" as const, authorName: u.name, authorInitials: u.initials,
        body: r.body, internal: r.internal, createdAt: r.createdAt.toISOString(), attachments: atts,
      };
    }
    if (r.accountUserId && acctAuthorById[r.accountUserId]) {
      const u = acctAuthorById[r.accountUserId]!;
      return {
        id: r.id, kind: "customer" as const, authorName: u.name, authorInitials: u.initials,
        body: r.body, internal: r.internal, createdAt: r.createdAt.toISOString(), attachments: atts,
      };
    }
    return {
      id: r.id, kind: "system" as const, authorName: "—", authorInitials: "·",
      body: r.body, internal: r.internal, createdAt: r.createdAt.toISOString(), attachments: atts,
    };
  });

  const eventRows = await db
    .select({
      id: statusEvents.id,
      fromStatus: statusEvents.fromStatus,
      toStatus: statusEvents.toStatus,
      reason: statusEvents.reason,
      at: statusEvents.at,
      byWorkspaceUserId: statusEvents.byWorkspaceUserId,
    })
    .from(statusEvents)
    .where(eq(statusEvents.itemId, head.id))
    .orderBy(asc(statusEvents.at));

  const events = eventRows.map(e => ({
    id: e.id,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    reason: e.reason,
    byName: e.byWorkspaceUserId ? (wsAuthorById[e.byWorkspaceUserId]?.name ?? null) : null,
    at: e.at.toISOString(),
  }));

  const initiativeOptions = await db
    .select({ id: initiatives.id, name: initiatives.name, color: initiatives.color })
    .from(initiatives)
    .where(and(eq(initiatives.workspaceId, workspaceId), ne(initiatives.status, "parked")))
    .orderBy(asc(initiatives.name));

  const [suggestionRow] = await db
    .select({
      id: initiativeSuggestions.id,
      initiativeId: initiativeSuggestions.initiativeId,
      confidence: initiativeSuggestions.confidence,
      reason: initiativeSuggestions.reason,
      initiativeName: initiatives.name,
      initiativeColor: initiatives.color,
    })
    .from(initiativeSuggestions)
    .innerJoin(initiatives, eq(initiatives.id, initiativeSuggestions.initiativeId))
    .where(and(
      eq(initiativeSuggestions.itemId, head.id),
      eq(initiativeSuggestions.status, "pending"),
    ))
    .orderBy(desc(initiativeSuggestions.createdAt))
    .limit(1);

  // Linked replay session (one item ↔ at most one session). The card
  // disappears if there's nothing recorded for this item — including the
  // common case where session record is disabled for the workspace.
  const replayManifest = await getReplayForItem(head.shortId, workspaceId);
  const replay = replayManifest
    ? {
        id: replayManifest.id,
        startedAt: replayManifest.startedAt,
        endedAt: replayManifest.endedAt,
        pageUrl: replayManifest.pageUrl,
        userAgent: replayManifest.userAgent,
        viewportW: replayManifest.viewportW,
        viewportH: replayManifest.viewportH,
        eventCount: replayManifest.eventCount,
        sizeBytes: replayManifest.sizeBytes,
        durationMs: replayManifest.durationMs,
        chunks: replayManifest.chunks,
      }
    : null;

  return {
    item: {
      shortId: head.shortId,
      title: head.title,
      body: head.body,
      type: head.type,
      status: head.status,
      externalProvider:  head.externalProvider as "linear" | "jira" | "github" | null,
      externalTicketId:  head.externalTicketId,
      externalTicketUrl: head.externalTicketUrl,
      externalStatus:    head.externalStatus,
      externalSyncedAt:  head.externalSyncedAt ? head.externalSyncedAt.toISOString() : null,
      createdAt: head.createdAt.toISOString(),
    },
    account: {
      id: head.accountId,
      name: head.accountName,
      arrCents: head.accountArr,
    },
    submitter: {
      name: head.submitterName,
      initials: head.submitterInitials,
    },
    assignee: head.assigneeInitials ? { initials: head.assigneeInitials, name: head.assigneeName ?? "" } : null,
    messages,
    events,
    teammates: wsAuthor, // for @-mention autocomplete + highlight (internal notes)
    initiative: head.initiativeId
      ? { id: head.initiativeId, name: head.initiativeName ?? "", color: head.initiativeColor }
      : null,
    initiativeOptions,
    canManageInitiatives,
    suggestion: suggestionRow
      ? {
          id: suggestionRow.id,
          initiativeId: suggestionRow.initiativeId,
          initiativeName: suggestionRow.initiativeName,
          initiativeColor: suggestionRow.initiativeColor,
          confidence: suggestionRow.confidence,
          reason: suggestionRow.reason,
        }
      : null,
    workspaceIntegrations: {
      linearInstalledAt: workspace.linearInstalledAt ? workspace.linearInstalledAt.toISOString() : null,
      jiraInstalledAt:   workspace.jiraInstalledAt   ? workspace.jiraInstalledAt.toISOString()   : null,
      githubInstalledAt: workspace.githubInstalledAt ? workspace.githubInstalledAt.toISOString() : null,
    },
    aiTicketAvailable: ticketSuggestionConfigured() && hasFeature(workspace, "ai"),
    replay,
  };
}

export async function ThreadViewTile({ shortId }: { shortId: string }) {
  const { workspace, user } = await getActiveSession();
  const canManageInitiatives = user.role === "admin" || user.role === "pm";
  const data = await loadThread(workspace, shortId, canManageInitiatives);
  if (!data) notFound();
  const canWrite = user.role === "admin" || user.role === "pm";
  return <ThreadView data={data} canWrite={canWrite} />;
}
