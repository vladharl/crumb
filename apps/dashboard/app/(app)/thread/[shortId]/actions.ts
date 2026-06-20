"use server";

import { db, items, replies, statusEvents, workspaces, ticketSuggestions, dedupeSuggestions, replaySessions } from "@crumb/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { findDuplicateCandidates } from "@/lib/ai/dedup";
import { replyConfigured, draftReply, translate } from "@/lib/ai/reply";
import { withAiBudget } from "@/lib/ai/run";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import * as Linear from "@/lib/integrations/linear";
import * as Jira from "@/lib/integrations/jira";
import * as Github from "@/lib/integrations/github";
import { suggestTicket, ticketSuggestionConfigured, TICKET_MODEL } from "@/lib/ai/ticket";
import { open } from "@/lib/crypto-at-rest";
import { consumeAi } from "@/lib/usage";
import { IntegrationAuthError, clearProviderInstall } from "@/lib/integrations/revoke";
import { emitEvent } from "@/lib/webhooks";
import { createItemReply, updateItemStatus, assignItemTo, type Status, type VendorRole } from "@/lib/items/mutations";
import { log } from "@/lib/log";

// On a provider auth failure (revoked/expired token), clear the install so
// Settings shows "disconnected", and return a typed `<provider>_revoked`
// error. Returns null for any other error so the caller's normal handling
// runs. (Jira also self-clears in its refresh path; clearing again is a no-op.)
async function handleRevoke(err: unknown, workspaceId: string): Promise<{ ok: false; error: string } | null> {
  if (err instanceof IntegrationAuthError) {
    await clearProviderInstall(workspaceId, err.provider);
    return { ok: false, error: `${err.provider}_revoked` };
  }
  return null;
}

// Thin session-bound wrappers over the shared cores in lib/items/mutations.ts.
// They resolve the dashboard session into a VendorActor + origin, delegate, and
// own the Next cache invalidation (revalidatePath can't run from the MCP path).

export async function createReply(input: {
  itemShortId: string;
  body: string;
  internal: boolean;
  attachmentIds?: string[];
}) {
  const { workspace, user } = await getActiveSession();
  const r = await createItemReply(
    { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole },
    { ...input, origin: originFromHeaders(headers()) },
  );
  if (r.ok) {
    revalidatePath(`/thread/${input.itemShortId}`);
    revalidatePath("/inbox");
  }
  return r;
}

export async function updateStatus(input: {
  itemShortId: string;
  status: Status;
  reason?: string;
}) {
  const { workspace, user } = await getActiveSession();
  const r = await updateItemStatus(
    { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole },
    { ...input, origin: originFromHeaders(headers()) },
  );
  if (r.ok) {
    revalidatePath(`/thread/${input.itemShortId}`);
    revalidatePath("/inbox");
  }
  return r;
}

// ─── single-item properties (assignee / type) ────────────────
// The thread's Details card edits one item in place — the per-item
// counterpart of the inbox bulk bar.

export async function assignItem(
  itemShortId: string,
  assigneeId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  const r = await assignItemTo(
    { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole },
    { itemShortId, assigneeId },
  );
  if (r.ok) {
    revalidatePath(`/thread/${itemShortId}`);
    revalidatePath("/inbox");
  }
  return r;
}

const ALLOWED_TYPES = new Set(["bug", "idea", "question"]);

export async function updateType(
  itemShortId: string,
  type: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ALLOWED_TYPES.has(type)) return { ok: false, error: "bad_type" };
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const r = await db
    .update(items)
    .set({ type, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .returning({ id: items.id });
  if (r.length === 0) return { ok: false, error: "not_found" };

  revalidatePath(`/thread/${itemShortId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

// ─── external ticket linking ─────────────────────────────────

type Provider = "linear" | "jira" | "github";

export type CreateExternalTicketInput = {
  itemShortId: string;
  provider: Provider;
  title: string;
  body: string;
  // Provider-specific target. For Linear, this is the teamId. For Jira:
  // projectKey. For GitHub: "owner/repo". null means "use workspace default".
  target: string | null;
};

export type CreateExternalTicketResult =
  | { ok: true; externalTicketId: string; externalTicketUrl: string }
  | { ok: false; error: string };

export async function createExternalTicket(input: CreateExternalTicketInput): Promise<CreateExternalTicketResult> {
  const title = input.title?.trim();
  const body = input.body?.trim() ?? "";
  if (!title) return { ok: false, error: "missing_title" };

  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  // Confirm the item belongs to this workspace before we burn a real
  // API call against the external provider.
  const [row] = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      currentProvider: items.externalProvider,
      currentTicketId: items.externalTicketId,
    })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (row.currentTicketId) return { ok: false, error: "already_linked" };

  if (input.provider === "linear") {
    const token = workspace.linearAccessToken;
    if (!token) return { ok: false, error: "linear_not_connected" };
    const teamId = input.target ?? workspace.linearTeamId;
    if (!teamId) return { ok: false, error: "no_team" };

    let issue;
    try {
      issue = await Linear.createIssue(open(token), { teamId, title, description: body });
    } catch (err) {
      const rv = await handleRevoke(err, workspace.id);
      if (rv) return rv;
      log.error("linear createIssue failed", { scope: "crumb/linear", err });
      return { ok: false, error: "provider_create_failed" };
    }

    await db
      .update(items)
      .set({
        externalProvider:  "linear",
        externalTicketId:  issue.identifier,
        externalTicketUrl: issue.url,
        externalStatus:    issue.stateName,
        externalSyncedAt:  new Date(),
        updatedAt:         new Date(),
      })
      .where(eq(items.id, row.id));

    revalidatePath(`/thread/${input.itemShortId}`);
    revalidatePath("/inbox");
    return { ok: true, externalTicketId: issue.identifier, externalTicketUrl: issue.url };
  }

  if (input.provider === "jira") {
    if (!workspace.jiraAccessToken || !workspace.jiraRefreshToken) {
      return { ok: false, error: "jira_not_connected" };
    }
    const projectKey = input.target ?? workspace.jiraDefaultProjectKey;
    if (!projectKey) return { ok: false, error: "no_project" };

    let issue;
    try {
      issue = await Jira.createIssue(workspace, { projectKey, title, description: body });
    } catch (err) {
      const rv = await handleRevoke(err, workspace.id);
      if (rv) return rv;
      log.error("jira createIssue failed", { scope: "crumb/jira", err });
      return { ok: false, error: "provider_create_failed" };
    }

    await db
      .update(items)
      .set({
        externalProvider:  "jira",
        externalTicketId:  issue.key,
        externalTicketUrl: issue.url,
        externalStatus:    issue.statusName,
        externalSyncedAt:  new Date(),
        updatedAt:         new Date(),
      })
      .where(eq(items.id, row.id));

    revalidatePath(`/thread/${input.itemShortId}`);
    revalidatePath("/inbox");
    return { ok: true, externalTicketId: issue.key, externalTicketUrl: issue.url };
  }

  if (input.provider === "github") {
    if (!workspace.githubAppInstallId) return { ok: false, error: "github_not_connected" };
    const repo = input.target ?? workspace.githubDefaultRepo;
    if (!repo) return { ok: false, error: "no_repo" };

    let issue;
    try {
      issue = await Github.createIssue(workspace.githubAppInstallId, repo, { title, body });
    } catch (err) {
      log.error("github createIssue failed", { scope: "crumb/github", err });
      return { ok: false, error: "provider_create_failed" };
    }

    const ticketRef = `#${issue.number}`;
    await db
      .update(items)
      .set({
        externalProvider:  "github",
        externalTicketId:  ticketRef,
        externalTicketUrl: issue.url,
        externalStatus:    issue.state,
        externalSyncedAt:  new Date(),
        updatedAt:         new Date(),
      })
      .where(eq(items.id, row.id));

    revalidatePath(`/thread/${input.itemShortId}`);
    revalidatePath("/inbox");
    return { ok: true, externalTicketId: ticketRef, externalTicketUrl: issue.url };
  }

  return { ok: false, error: "provider_not_supported" };
}

export async function unlinkExternalTicket(itemShortId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const r = await db
    .update(items)
    .set({
      externalProvider:  null,
      externalTicketId:  null,
      externalTicketUrl: null,
      externalStatus:    null,
      externalSyncedAt:  null,
      updatedAt:         new Date(),
    })
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .returning({ id: items.id });
  if (r.length === 0) return { ok: false, error: "not_found" };

  revalidatePath(`/thread/${itemShortId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

// Used by the modal to populate the team picker for Linear. Returns the
// connected provider's targets so the UI doesn't need to call the provider
// API from the client.
export async function listProviderTargets(provider: Provider): Promise<
  | { ok: true; targets: Array<{ id: string; label: string }>; defaultTarget: string | null }
  | { ok: false; error: string }
> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  if (provider === "linear") {
    const token = workspace.linearAccessToken;
    if (!token) return { ok: false, error: "linear_not_connected" };
    try {
      const teams = await Linear.listTeams(open(token));
      return {
        ok: true,
        targets: teams.map(t => ({ id: t.id, label: `${t.name} (${t.key})` })),
        defaultTarget: workspace.linearTeamId ?? null,
      };
    } catch (err) {
      const rv = await handleRevoke(err, workspace.id);
      if (rv) return rv;
      log.error("linear listTeams failed", { scope: "crumb/linear", err });
      return { ok: false, error: "provider_list_failed" };
    }
  }

  if (provider === "jira") {
    if (!workspace.jiraAccessToken) return { ok: false, error: "jira_not_connected" };
    try {
      const projects = await Jira.listProjects(workspace);
      return {
        ok: true,
        // Jira's "target" is the project KEY (not id) — that's what the
        // create endpoint takes and what survives across moves.
        targets: projects.map(p => ({ id: p.key, label: `${p.name} (${p.key})` })),
        defaultTarget: workspace.jiraDefaultProjectKey ?? null,
      };
    } catch (err) {
      const rv = await handleRevoke(err, workspace.id);
      if (rv) return rv;
      log.error("jira listProjects failed", { scope: "crumb/jira", err });
      return { ok: false, error: "provider_list_failed" };
    }
  }

  if (provider === "github") {
    if (!workspace.githubAppInstallId) return { ok: false, error: "github_not_connected" };
    try {
      const repos = await Github.listInstallationRepos(workspace.githubAppInstallId);
      return {
        ok: true,
        targets: repos.map(r => ({ id: r.fullName, label: r.fullName })),
        defaultTarget: workspace.githubDefaultRepo ?? null,
      };
    } catch (err) {
      log.error("github listInstallationRepos failed", { scope: "crumb/github", err });
      return { ok: false, error: "provider_list_failed" };
    }
  }

  return { ok: false, error: "provider_not_supported" };
}

// AI draft for an external ticket. Cloud-only; pulls 10 recent ticket
// titles from the target provider to give the model the team's voice.
// Persists the suggestion (pending) so a future audit can show
// "AI proposed X, vendor edited to Y".
export type SuggestExternalTicketResult =
  | { ok: true; title: string; body: string; labels: string[] | null; reason: string; confidence: number; suggestionId: string }
  | { ok: false; error: string };

export async function suggestExternalTicket(
  itemShortId: string,
  provider: Provider,
): Promise<SuggestExternalTicketResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  if (!ticketSuggestionConfigured()) return { ok: false, error: "not_configured" };

  // Monthly AI cost cap (shared budget with clustering) — atomic consume.
  if (!(await consumeAi(workspace)).ok) return { ok: false, error: "ai_cap_reached" };

  const [item] = await db
    .select({
      id: items.id,
      title: items.title,
      body: items.body,
      type: items.type,
    })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };

  // Fetch recent tickets from the target provider for voice context.
  // Each provider supplies a small adapter; only Linear is wired in this
  // chunk. Jira / GitHub fall through with an empty list (the model still
  // produces a sensible draft, just less stylistically matched).
  let recentTickets: Array<{ identifier: string; title: string; stateName: string }> = [];
  let providerTarget: string | null = null;

  if (provider === "linear") {
    if (!workspace.linearAccessToken || !workspace.linearTeamId) {
      return { ok: false, error: "linear_not_connected" };
    }
    providerTarget = workspace.linearTeamId;
    try {
      recentTickets = await Linear.listRecentIssues(open(workspace.linearAccessToken), workspace.linearTeamId, 10);
    } catch (err) {
      // Even on this best-effort path, a revoked token should clear the install.
      if (err instanceof IntegrationAuthError) void clearProviderInstall(workspace.id, err.provider);
      log.warn("listRecentIssues(Linear) failed (non-fatal)", { scope: "crumb/ai", err });
    }
  } else if (provider === "jira") {
    if (!workspace.jiraAccessToken || !workspace.jiraDefaultProjectKey) {
      return { ok: false, error: "jira_not_connected" };
    }
    providerTarget = workspace.jiraDefaultProjectKey;
    try {
      recentTickets = await Jira.listRecentIssues(workspace, workspace.jiraDefaultProjectKey, 10);
    } catch (err) {
      log.warn("listRecentIssues(Jira) failed (non-fatal)", { scope: "crumb/ai", err });
    }
  } else if (provider === "github") {
    if (!workspace.githubAppInstallId || !workspace.githubDefaultRepo) {
      return { ok: false, error: "github_not_connected" };
    }
    providerTarget = workspace.githubDefaultRepo;
    try {
      recentTickets = await Github.listRecentIssues(workspace.githubAppInstallId, workspace.githubDefaultRepo, 10);
    } catch (err) {
      log.warn("listRecentIssues(GitHub) failed (non-fatal)", { scope: "crumb/ai", err });
    }
  }

  // GitHub repo context feeds *all* providers' drafts when a GitHub repo
  // is connected on this workspace — teams often use GitHub for code +
  // Linear/Jira for tickets, and the model gets the project framing from
  // the README + tree regardless of where the ticket lands.
  let repoContext: { repo: string; readme: string | null; topLevelTree: string | null } | undefined;
  if (workspace.githubAppInstallId && workspace.githubDefaultRepo) {
    try {
      repoContext = await Github.getRepoContext(workspace.githubAppInstallId, workspace.githubDefaultRepo);
    } catch (err) {
      log.warn("getRepoContext failed (non-fatal)", { scope: "crumb/ai", err });
    }
  }

  const draft = await suggestTicket({
    provider,
    item: { title: item.title, body: item.body, type: item.type },
    recentTickets,
    repoContext,
  });
  if (!draft) return { ok: false, error: "draft_failed" };

  const [stored] = await db.insert(ticketSuggestions).values({
    itemId: item.id,
    provider,
    draftTitle: draft.title,
    draftBody: draft.body,
    draftLabels: draft.labels,
    providerTarget,
    confidence: draft.confidence,
    reason: draft.reason,
    model: TICKET_MODEL,
  }).returning({ id: ticketSuggestions.id });

  return {
    ok: true,
    title: draft.title,
    body: draft.body,
    labels: draft.labels,
    reason: draft.reason,
    confidence: draft.confidence,
    suggestionId: stored.id,
  };
}

// Update the workspace-level default target for a provider (e.g. switch
// Linear team). Stored on workspaces so future creates default to it.
export async function updateProviderDefault(provider: Provider, target: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  if (provider === "linear") {
    if (!workspace.linearAccessToken) return { ok: false, error: "linear_not_connected" };
    // Re-fetch the team name to keep the cached label fresh.
    let teamName: string | null = null;
    try {
      const teams = await Linear.listTeams(open(workspace.linearAccessToken));
      teamName = teams.find(t => t.id === target)?.name ?? null;
    } catch {
      // Non-fatal — we still write the id.
    }
    if (!teamName) return { ok: false, error: "team_not_found" };

    await db
      .update(workspaces)
      .set({ linearTeamId: target, linearTeamName: teamName })
      .where(eq(workspaces.id, workspace.id));
    revalidatePath("/settings/integrations");
    return { ok: true };
  }

  if (provider === "jira") {
    if (!workspace.jiraAccessToken) return { ok: false, error: "jira_not_connected" };
    // Confirm the project key still exists on the connected site.
    try {
      const projects = await Jira.listProjects(workspace);
      if (!projects.find(p => p.key === target)) return { ok: false, error: "project_not_found" };
    } catch {
      // Non-fatal — write through and let the next create surface a clearer error.
    }
    await db
      .update(workspaces)
      .set({ jiraDefaultProjectKey: target })
      .where(eq(workspaces.id, workspace.id));
    revalidatePath("/settings/integrations");
    return { ok: true };
  }

  if (provider === "github") {
    if (!workspace.githubAppInstallId) return { ok: false, error: "github_not_connected" };
    try {
      const repos = await Github.listInstallationRepos(workspace.githubAppInstallId);
      if (!repos.find(r => r.fullName === target)) return { ok: false, error: "repo_not_found" };
    } catch {
      // Non-fatal.
    }
    await db
      .update(workspaces)
      .set({ githubDefaultRepo: target })
      .where(eq(workspaces.id, workspace.id));
    revalidatePath("/settings/integrations");
    return { ok: true };
  }

  return { ok: false, error: "provider_not_supported" };
}

// ─── duplicate detection & smart merge (feature 4) ───────────

export type DuplicateCandidateView = {
  shortId: string;
  title: string;
  status: string;
  similarity: number;
};

// Semantic neighbours for this item (pgvector). Empty on self-host (no
// embeddings) or when nothing is similar enough. Admin/pm only.
export async function listDuplicateCandidates(
  itemShortId: string,
): Promise<{ ok: true; candidates: DuplicateCandidateView[] } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };

  // Looser threshold than the capture-time auto-flag — PMs are browsing here.
  const candidates = await findDuplicateCandidates({
    workspaceId: workspace.id,
    itemId: item.id,
    limit: 8,
    threshold: 0.78,
  });
  return {
    ok: true,
    candidates: candidates.map((c) => ({
      shortId: c.shortId,
      title: c.title,
      status: c.status,
      similarity: c.similarity,
    })),
  };
}

// Fold `source` into `target` (the canonical). Source becomes status=duplicate
// with merged_into_id set; its replay sessions re-point to the canonical so
// they surface there, and any pending dedupe suggestion resolves. The group's
// combined ARR/followers are computed at read time (ThreadViewTile), never
// stored, so they stay correct as ARR changes. Admin/pm only.
export async function mergeItems(
  sourceShortId: string,
  targetShortId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sourceShortId === targetShortId) return { ok: false, error: "same_item" };
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const rows = await db
    .select({ id: items.id, shortId: items.shortId, title: items.title, type: items.type, status: items.status, mergedIntoId: items.mergedIntoId })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), inArray(items.shortId, [sourceShortId, targetShortId])));
  const source = rows.find((r) => r.shortId === sourceShortId);
  const target = rows.find((r) => r.shortId === targetShortId);
  if (!source || !target) return { ok: false, error: "not_found" };
  // Can't merge into something that's itself a duplicate (would create a chain).
  if (target.mergedIntoId) return { ok: false, error: "target_is_duplicate" };
  // Source must not already have duplicates folded into it (keep a depth-1 tree).
  const [dep] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.mergedIntoId, source.id)))
    .limit(1);
  if (dep) return { ok: false, error: "source_has_duplicates" };

  await db
    .update(items)
    .set({
      status: "duplicate",
      mergedIntoId: target.id,
      mergedAt: new Date(),
      mergedByWorkspaceUserId: user.id,
      updatedAt: new Date(),
    })
    .where(eq(items.id, source.id));
  await db.insert(statusEvents).values({
    itemId: source.id,
    fromStatus: source.status,
    toStatus: "duplicate",
    reason: `Merged into ${targetShortId}`,
    byWorkspaceUserId: user.id,
  });
  // Re-point replay sessions to the canonical item.
  await db.update(replaySessions).set({ itemId: target.id }).where(eq(replaySessions.itemId, source.id));
  // Resolve any pending dedupe suggestion that proposed this merge.
  await db
    .update(dedupeSuggestions)
    .set({ status: "accepted", decidedAt: new Date() })
    .where(and(eq(dedupeSuggestions.itemId, source.id), eq(dedupeSuggestions.status, "pending")));

  void emitEvent(workspace.id, {
    type: "item.merged",
    workspace: workspace.slug,
    item: { short_id: source.shortId, title: source.title, type: source.type },
    into: { short_id: targetShortId },
    at: new Date().toISOString(),
  });

  revalidatePath(`/thread/${targetShortId}`);
  revalidatePath(`/thread/${sourceShortId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

// Reverse a merge: the item returns to the open inbox as a standalone request.
export async function unmergeItem(shortId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const [row] = await db
    .select({ id: items.id, mergedIntoId: items.mergedIntoId })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, shortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (!row.mergedIntoId) return { ok: false, error: "not_merged" };

  await db
    .update(items)
    .set({ status: "open", mergedIntoId: null, mergedAt: null, mergedByWorkspaceUserId: null, updatedAt: new Date() })
    .where(eq(items.id, row.id));
  await db.insert(statusEvents).values({
    itemId: row.id,
    fromStatus: "duplicate",
    toStatus: "open",
    reason: "Unmerged",
    byWorkspaceUserId: user.id,
  });

  revalidatePath(`/thread/${shortId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

// Dismiss a pending dedupe suggestion without merging (the inbox flag clears).
export async function dismissDuplicateSuggestion(
  itemShortId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };

  await db
    .update(dedupeSuggestions)
    .set({ status: "dismissed", decidedAt: new Date() })
    .where(and(eq(dedupeSuggestions.itemId, item.id), eq(dedupeSuggestions.status, "pending")));

  revalidatePath(`/thread/${itemShortId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

// ─── AI reply drafting + translation (feature 7) ─────────────

// The vendor's working language. No per-workspace setting yet — default English;
// translation targets this when inbound feedback is in another language.
const WORKSPACE_LANG = "en";

// Draft a customer-facing close-the-loop reply in the vendor's voice. Returns
// the draft text for the composer to load (the vendor edits before sending).
export async function draftReplyAction(
  itemShortId: string,
): Promise<{ ok: true; draft: string } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  if (!replyConfigured()) return { ok: false, error: "not_configured" };

  const [item] = await db
    .select({ title: items.title, body: items.body, type: items.type, status: items.status })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };

  // A few recent customer-facing vendor replies across the workspace, for voice.
  const recent = await db
    .select({ body: replies.body })
    .from(replies)
    .innerJoin(items, eq(items.id, replies.itemId))
    .where(and(eq(items.workspaceId, workspace.id), isNotNull(replies.workspaceUserId), eq(replies.internal, false)))
    .orderBy(desc(replies.createdAt))
    .limit(5);

  const budget = await withAiBudget(workspace, () =>
    draftReply({ item, recentVendorReplies: recent.map(r => r.body) }),
  );
  if (!budget.ok) return { ok: false, error: budget.error };
  if (!budget.value) return { ok: false, error: "draft_failed" };
  return { ok: true, draft: budget.value.draft };
}

// Translate the inbound feedback into the workspace language, stored on the item
// (title_translated / body_translated). Idempotent-ish: re-running re-translates.
export async function translateItem(
  itemShortId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  if (!replyConfigured()) return { ok: false, error: "not_configured" };

  const [item] = await db
    .select({ id: items.id, title: items.title, body: items.body })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };

  const budget = await withAiBudget(workspace, async () => {
    const [t, b] = await Promise.all([
      translate(item.title, WORKSPACE_LANG),
      item.body ? translate(item.body, WORKSPACE_LANG) : Promise.resolve(""),
    ]);
    return { title: t, body: b ?? "" };
  });
  if (!budget.ok) return { ok: false, error: budget.error };
  const v = budget.value;
  if (!v.title && !v.body) return { ok: false, error: "translate_failed" };

  await db
    .update(items)
    .set({ titleTranslated: v.title, bodyTranslated: v.body, translatedAt: new Date() })
    .where(eq(items.id, item.id));
  revalidatePath(`/thread/${itemShortId}`);
  return { ok: true };
}
