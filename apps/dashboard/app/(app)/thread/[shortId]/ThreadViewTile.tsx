import { notFound } from "next/navigation";
import { db, items, accounts, accountUsers, workspaceUsers, replies, statusEvents, attachments, initiatives, initiativeSuggestions, dedupeSuggestions, replaySummaries, customerNotifications } from "@crumb/db";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getActiveSession } from "@/lib/server";
import { ticketSuggestionConfigured } from "@/lib/ai/ticket";
import { embeddingsConfigured } from "@/lib/ai/embeddings";
import { replyConfigured } from "@/lib/ai/reply";
import { replaySummaryConfigured } from "@/lib/ai/replay-summary";
import { getReplayForItem } from "@/lib/replay/read";
import { hasFeature, usageAnalyticsAllowed } from "@/lib/entitlements";
import { eventsBefore } from "@/lib/usage/signals";
import { emailConfigured } from "@/lib/email";
import { customerNotifyPlan } from "@/lib/notify/customer-plan";
import { ThreadView, type ThreadData } from "./ThreadView";

// Combined ARR + follower count over a merge group {canonical} ∪ {its
// duplicates}. Summed over DISTINCT accounts so two duplicates from the same
// account don't double-count ARR. Computed at read time so it stays correct as
// ARR changes (feature 4).
async function loadMergeGroup(itemId: string): Promise<{ combinedArrCents: number; accountCount: number; followerCount: number }> {
  // accountCount = the distinct accounts in the group (the inbox's "reach"),
  // computed off the same distinct-account set as the ARR sum so the two always
  // agree. That's the revenue-priority unit; followerCount (people) is kept for
  // the legacy display but is secondary.
  const [arrRows, followerRows] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(a.arr_cents), 0)::bigint AS arr, COUNT(*)::int AS accts
      FROM (
        SELECT DISTINCT i.account_id FROM items i
        WHERE i.id = ${itemId} OR i.merged_into_id = ${itemId}
      ) g
      JOIN accounts a ON a.id = g.account_id
    `) as unknown as Promise<Array<{ arr: string | number; accts: string | number }>>,
    db.execute(sql`
      SELECT COUNT(DISTINCT i.submitter_id)::int AS followers FROM items i
      WHERE i.id = ${itemId} OR i.merged_into_id = ${itemId}
    `) as unknown as Promise<Array<{ followers: string | number }>>,
  ]);
  return {
    combinedArrCents: Number(arrRows[0]?.arr ?? 0),
    accountCount: Number(arrRows[0]?.accts ?? 0),
    followerCount: Number(followerRows[0]?.followers ?? 0),
  };
}

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

// Usage breadcrumb: the submitter's tracked events leading up to submission.
// Gated like the other usage surfaces; returns null (card hidden) when off or
// empty. Best-effort — a failure must not block the thread from loading, so it
// can sit safely inside the parallel fan-out below.
async function loadUsageBreadcrumb(
  workspace: WorkspaceForThread,
  accountUserId: string,
  before: Date,
): Promise<Array<{ name: string; at: string; pageUrl: string | null }> | null> {
  if (!usageAnalyticsAllowed(workspace)) return null;
  try {
    const evs = await eventsBefore({ accountUserId, before, limit: 12 });
    return evs.length ? evs.map((e) => ({ name: e.name, at: e.ts.toISOString(), pageUrl: e.pageUrl })) : null;
  } catch {
    return null;
  }
}

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
      // Where it came in, and what customerNotifyPlan needs to say whether
      // the submitter is emailed.
      source: items.source,
      sourceUrl: items.sourceUrl,
      submitterEmail: accountUsers.email,
      submitterUnsub: accountUsers.unsubscribedAll,
      submitterNotifyReplies: accountUsers.notifyReplies,
      submitterNotifyStatus: accountUsers.notifyStatus,
      assigneeId: items.assigneeId,
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
      mergedIntoId: items.mergedIntoId,
      detectedLang: items.detectedLang,
      titleTranslated: items.titleTranslated,
      bodyTranslated: items.bodyTranslated,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, items.assigneeId))
    .leftJoin(initiatives, eq(initiatives.id, items.initiativeId))
    .where(and(eq(items.workspaceId, workspaceId), eq(items.shortId, shortId)))
    .limit(1);

  if (!head) return null;

  // ── merge group (feature 4) ──
  const sugItem = alias(items, "dup_candidate");
  const mergedIntoItem = alias(items, "merged_into");

  // Past the head lookup, every read below depends only on `head` and is
  // otherwise independent, so issue them concurrently. This used to be a chain
  // of ~15 sequential awaits — one DB round trip stacked after another — which
  // is most of why a thread was slow to open. Reply-scoped reads (attachments +
  // the customers those replies cite) and the replay summary chain off their
  // inputs further down.
  const [
    mergedIntoRow,
    mergedCount,
    mergeGroup,
    dupSuggestion,
    wsAuthor,
    rows,
    eventRows,
    noticeRows,
    initiativeOptions,
    suggestionRow,
    replayManifest,
    usageBreadcrumb,
  ] = await Promise.all([
    head.mergedIntoId
      ? db
          .select({ shortId: mergedIntoItem.shortId, title: mergedIntoItem.title })
          .from(mergedIntoItem)
          .where(eq(mergedIntoItem.id, head.mergedIntoId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(items)
      .where(eq(items.mergedIntoId, head.id))
      .then((r) => r[0]?.count ?? 0),
    loadMergeGroup(head.id),
    db
      .select({
        candidateShortId: sugItem.shortId,
        candidateTitle: sugItem.title,
        similarity: dedupeSuggestions.similarity,
      })
      .from(dedupeSuggestions)
      .innerJoin(sugItem, eq(sugItem.id, dedupeSuggestions.candidateItemId))
      .where(and(eq(dedupeSuggestions.itemId, head.id), eq(dedupeSuggestions.status, "pending")))
      .orderBy(desc(dedupeSuggestions.createdAt))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select({ id: workspaceUsers.id, name: workspaceUsers.name, initials: workspaceUsers.initials })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.workspaceId, workspaceId)),
    db
      .select()
      .from(replies)
      .where(eq(replies.itemId, head.id))
      .orderBy(asc(replies.createdAt)),
    db
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
      .orderBy(asc(statusEvents.at)),
    db
      .select({
        id: customerNotifications.id,
        kind: customerNotifications.kind,
        toStatus: customerNotifications.toStatus,
        sentAt: customerNotifications.sentAt,
      })
      .from(customerNotifications)
      .where(eq(customerNotifications.itemId, head.id))
      .orderBy(asc(customerNotifications.sentAt)),
    db
      .select({ id: initiatives.id, name: initiatives.name, color: initiatives.color })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, workspaceId), ne(initiatives.status, "parked")))
      .orderBy(asc(initiatives.name)),
    db
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
      .limit(1)
      .then((r) => r[0] ?? null),
    getReplayForItem(head.shortId, workspaceId),
    loadUsageBreadcrumb(workspace, head.submitterId, head.createdAt),
  ]);

  const { combinedArrCents, accountCount, followerCount } = mergeGroup;
  const wsAuthorById = Object.fromEntries(wsAuthor.map((u) => [u.id, u]));

  // Resolve only the customers these replies actually cite — not every account
  // user in the workspace. The old query loaded the entire account_users table
  // for the workspace on every thread open, so load time grew with customer
  // count regardless of thread size. Attachments fetch alongside the lookup.
  const replyIds = rows.map((r) => r.id);
  const acctAuthorIds = [...new Set(rows.map((r) => r.accountUserId).filter((id): id is string => !!id))];
  const acctAuthorPromise = acctAuthorIds.length === 0
    ? Promise.resolve([] as Array<{ id: string; name: string; initials: string }>)
    : db
        .select({ id: accountUsers.id, name: accountUsers.name, initials: accountUsers.initials })
        .from(accountUsers)
        .where(inArray(accountUsers.id, acctAuthorIds));
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
  const acctAuthor = await acctAuthorPromise;
  const acctAuthorById = Object.fromEntries(acctAuthor.map((u) => [u.id, u]));
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

  const events = eventRows.map(e => ({
    id: e.id,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    reason: e.reason,
    byName: e.byWorkspaceUserId ? (wsAuthorById[e.byWorkspaceUserId]?.name ?? null) : null,
    at: e.at.toISOString(),
  }));

  // Loop ledger entries — every time the customer was actually notified.
  // Rendered as crumbs in the Trail; a terminal-status notice is the loop
  // visibly closing ("Maya was told it shipped").
  const notices = noticeRows.map(n => ({
    id: n.id,
    kind: n.kind as "reply" | "status",
    toStatus: n.toStatus,
    at: n.sentAt.toISOString(),
  }));

  // Linked replay session (one item ↔ at most one session). The card
  // disappears if there's nothing recorded for this item — including the
  // common case where session record is disabled for the workspace.
  let replaySummaryRow: { summary: string; highlights: string[] | null } | null = null;
  if (replayManifest) {
    const [s] = await db
      .select({ summary: replaySummaries.summary, highlights: replaySummaries.highlights })
      .from(replaySummaries)
      .where(eq(replaySummaries.sessionId, replayManifest.id))
      .limit(1);
    replaySummaryRow = s ?? null;
  }
  const replay = replayManifest
    ? {
        id: replayManifest.id,
        startedAt: replayManifest.startedAt,
        endedAt: replayManifest.endedAt,
        pageUrl: replayManifest.pageUrl,
        userAgent: replayManifest.userAgent,
        viewportW: replayManifest.viewportW,
        viewportH: replayManifest.viewportH,
        screenW: replayManifest.screenW,
        screenH: replayManifest.screenH,
        deviceType: replayManifest.deviceType,
        browserName: replayManifest.browserName,
        browserVersion: replayManifest.browserVersion,
        osName: replayManifest.osName,
        osVersion: replayManifest.osVersion,
        callerIp: replayManifest.callerIp,
        geoCountry: replayManifest.geoCountry,
        geoCity: replayManifest.geoCity,
        eventCount: replayManifest.eventCount,
        sizeBytes: replayManifest.sizeBytes,
        durationMs: replayManifest.durationMs,
        chunks: replayManifest.chunks,
        summary: replaySummaryRow?.summary ?? null,
        highlights: replaySummaryRow?.highlights ?? null,
        aiSummaryAvailable: replaySummaryConfigured() && hasFeature(workspace, "ai"),
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
      detectedLang: head.detectedLang,
      titleTranslated: head.titleTranslated,
      bodyTranslated: head.bodyTranslated,
      source: head.source,
      // A deep link back to the call/ticket, from connector data: only an
      // http(s) URL is ever rendered as a link.
      sourceUrl: head.sourceUrl && /^https?:\/\//i.test(head.sourceUrl) ? head.sourceUrl : null,
    },
    // Whether a reply / status change will actually email the submitter: the
    // same plan the send paths gate on, so the composer's copy can't drift.
    notifyPlan: customerNotifyPlan({
      source: head.source,
      submitterEmail: head.submitterEmail,
      unsubscribedAll: head.submitterUnsub,
      notifyReplies: head.submitterNotifyReplies,
      notifyStatus: head.submitterNotifyStatus,
      emailConfigured: emailConfigured(),
    }),
    account: {
      id: head.accountId,
      name: head.accountName,
      arrCents: head.accountArr,
    },
    submitter: {
      name: head.submitterName,
      initials: head.submitterInitials,
    },
    assignee: head.assigneeId && head.assigneeInitials
      ? { id: head.assigneeId, initials: head.assigneeInitials, name: head.assigneeName ?? "" }
      : null,
    messages,
    events,
    notices,
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
    aiReplyAvailable: replyConfigured() && hasFeature(workspace, "ai"),
    replay,
    usageBreadcrumb,
    merge: {
      mergedInto: head.mergedIntoId && mergedIntoRow ? { shortId: mergedIntoRow.shortId, title: mergedIntoRow.title } : null,
      mergedCount,
      combinedArrCents,
      accountCount,
      followerCount,
      pendingSuggestion: dupSuggestion
        ? {
            candidateShortId: dupSuggestion.candidateShortId,
            candidateTitle: dupSuggestion.candidateTitle,
            similarity: dupSuggestion.similarity,
          }
        : null,
      // "Find similar" is only meaningful where embeddings exist (Cloud + AI).
      dedupAvailable: embeddingsConfigured() && hasFeature(workspace, "ai"),
    },
  };
}

export async function ThreadViewTile({ shortId }: { shortId: string }) {
  // Opt-in server timing for diagnosing "thread is slow to open" on a real
  // deployment (dev slowness is just on-demand route compilation). Set
  // CRUMB_PERF_LOG=1 and tail the server log: a high `load` ms points at DB
  // latency / pool contention, a low one means the cost is elsewhere (RSC
  // stream, CPU). Zero overhead when the env var is unset.
  const perf = process.env.CRUMB_PERF_LOG ? performance.now() : 0;
  const { workspace, user } = await getActiveSession();
  const sessionAt = perf ? performance.now() : 0;
  const canManageInitiatives = user.role === "admin" || user.role === "pm";
  const data = await loadThread(workspace, shortId, canManageInitiatives);
  if (perf) {
    const now = performance.now();
    console.log(
      `[perf] thread ${shortId} session=${(sessionAt - perf).toFixed(0)}ms load=${(now - sessionAt).toFixed(0)}ms total=${(now - perf).toFixed(0)}ms`,
    );
  }
  if (!data) notFound();
  const canWrite = user.role === "admin" || user.role === "pm";
  return <ThreadView data={data} canWrite={canWrite} />;
}
