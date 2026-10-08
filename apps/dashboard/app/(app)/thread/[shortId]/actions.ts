"use server";

import {
  db, items, accounts, accountUsers, replies, statusEvents, workspaces, ticketSuggestions, dedupeSuggestions, replaySessions,
  type Workspace,
} from "@crumb/db";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { findDuplicateCandidates } from "@/lib/ai/dedup";
import { replyConfigured, draftReply, translate } from "@/lib/ai/reply";
import { withAiBudget } from "@/lib/ai/run";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { integrationsAllowed } from "@/lib/entitlements";
import { isCloud } from "@/lib/tier";
import * as Linear from "@/lib/integrations/linear";
import * as Jira from "@/lib/integrations/jira";
import * as Github from "@/lib/integrations/github";
import { suggestTicket, ticketSuggestionConfigured, TICKET_MODEL } from "@/lib/ai/ticket";
import { open } from "@/lib/crypto-at-rest";
import { IntegrationAuthError, clearProviderInstall } from "@/lib/integrations/revoke";
import { emitEvent } from "@/lib/webhooks";
import {
  createItemReply, updateItemStatus, replyAndSetItemStatus, assignItemTo, notifyMergedItem, mergeNoticePlan,
  type Status, type VendorRole,
} from "@/lib/items/mutations";
import type { NotifyPlan } from "@/lib/notify/customer-plan";
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
// On success, `emailed` says whether a real provider accepted an email to the
// customer (never on stdout), so the UI never has to guess.

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

// Reply and close in one action: posts the reply, sets shipped/declined, and
// sends the customer one email (the outcome with the reply in it). For
// declined, the reply is the reason. `mergedEmailed` counts the customers whose
// requests were merged into this one who got the outcome email too, without
// the reply (updateItemStatus's fan-out).
export async function replyAndSetStatus(input: {
  itemShortId: string;
  body: string;
  status: "shipped" | "declined";
  attachmentIds?: string[];
}): Promise<{ ok: true; emailed: boolean; mergedEmailed: number } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  const r = await replyAndSetItemStatus(
    { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole },
    { ...input, origin: originFromHeaders(headers()) },
  );
  if (!r.ok) return r;
  revalidatePath(`/thread/${input.itemShortId}`);
  revalidatePath("/inbox");
  return { ok: true, emailed: r.emailed, mergedEmailed: r.mergedEmailed };
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
  // Label names (an AI draft's, as edited in the modal). GitHub applies them;
  // Linear and Jira get them as a last line of the description.
  labels?: string[];
};

export type CreateExternalTicketResult =
  | { ok: true; externalTicketId: string; externalTicketUrl: string }
  | { ok: false; error: string };

export async function createExternalTicket(input: CreateExternalTicketInput): Promise<CreateExternalTicketResult> {
  const title = input.title?.trim();
  const body = input.body?.trim() ?? "";
  if (!title) return { ok: false, error: "missing_title" };
  const labels = Array.isArray(input.labels)
    ? input.labels.filter((l): l is string => typeof l === "string").map(l => l.trim().slice(0, 50)).filter(Boolean).slice(0, 10)
    : [];

  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  // A downgrade keeps the tracker tokens; the plan decides whether they're used.
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };

  // Confirm the item belongs to this workspace before we burn a real
  // API call against the external provider.
  const [row] = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      currentTicketId: items.externalTicketId,
    })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (row.currentTicketId) return { ok: false, error: "already_linked" };

  // ponytail: Linear takes label ids and lib/integrations/jira doesn't send
  // fields.labels yet, so their labels ride in the description. Pass them
  // natively once those clients take label names.
  const description = labels.length ? `${body}\n\nLabels: ${labels.join(", ")}`.trim() : body;

  // id is the key people see (ENG-42); uid the tracker's own id, which the
  // status webhooks match on so a moved or renamed issue keeps syncing.
  let ticket: { id: string; uid: string; url: string; status: string };
  try {
    if (input.provider === "linear") {
      const token = workspace.linearAccessToken;
      if (!token) return { ok: false, error: "linear_not_connected" };
      const teamId = input.target ?? workspace.linearTeamId;
      if (!teamId) return { ok: false, error: "no_team" };
      const issue = await Linear.createIssue(open(token), { teamId, title, description });
      ticket = { id: issue.identifier, uid: issue.id, url: issue.url, status: issue.stateName };
    } else if (input.provider === "jira") {
      if (!workspace.jiraAccessToken || !workspace.jiraRefreshToken) {
        return { ok: false, error: "jira_not_connected" };
      }
      const projectKey = input.target ?? workspace.jiraDefaultProjectKey;
      if (!projectKey) return { ok: false, error: "no_project" };
      const issue = await Jira.createIssue(workspace, { projectKey, title, description });
      ticket = { id: issue.key, uid: issue.id, url: issue.url, status: issue.statusName };
    } else if (input.provider === "github") {
      if (!workspace.githubAppInstallId) return { ok: false, error: "github_not_connected" };
      const repo = input.target ?? workspace.githubDefaultRepo;
      if (!repo) return { ok: false, error: "no_repo" };
      const issue = await Github.createIssue(workspace.githubAppInstallId, repo, {
        title,
        body,
        labels: labels.length ? labels : undefined,
      });
      ticket = { id: Github.issueTicketRef(repo, issue.number), uid: issue.nodeId, url: issue.url, status: issue.state };
    } else {
      return { ok: false, error: "provider_not_supported" };
    }
  } catch (err) {
    const rv = await handleRevoke(err, workspace.id);
    if (rv) return rv;
    log.error(`${input.provider} createIssue failed`, { scope: `crumb/${input.provider}`, err });
    return { ok: false, error: "provider_create_failed" };
  }

  await db
    .update(items)
    .set({
      externalProvider:  input.provider,
      externalTicketId:  ticket.id,
      externalTicketUid: ticket.uid,
      externalTicketUrl: ticket.url,
      externalStatus:    ticket.status,
      // Stamped by the status webhooks only, so it says when the tracker last
      // reported (the Engineering tile shows it); null until it first does.
      externalSyncedAt:  null,
      updatedAt:         new Date(),
    })
    .where(eq(items.id, row.id));

  void emitEvent(workspace.id, {
    type: "ticket.linked",
    workspace: workspace.slug,
    item: { short_id: row.shortId, title: row.title, type: row.type },
    ticket: { provider: input.provider, id: ticket.id, url: ticket.url },
    at: new Date().toISOString(),
  });

  revalidatePath(`/thread/${input.itemShortId}`);
  revalidatePath("/inbox");
  return { ok: true, externalTicketId: ticket.id, externalTicketUrl: ticket.url };
}

// Unlinking stays open after a downgrade: it's cleanup, and the ticket itself
// stays in the tracker.
export async function unlinkExternalTicket(itemShortId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const [row] = await db
    .select({
      id: items.id,
      title: items.title,
      type: items.type,
      provider: items.externalProvider,
      ticketId: items.externalTicketId,
      ticketUrl: items.externalTicketUrl,
    })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };

  // Only the call that actually clears a link reports it, so a double click
  // doesn't send two ticket.unlinked events.
  const cleared = await db
    .update(items)
    .set({
      externalProvider:  null,
      externalTicketId:  null,
      externalTicketUid: null,
      externalTicketUrl: null,
      externalStatus:    null,
      externalSyncedAt:  null,
      updatedAt:         new Date(),
    })
    .where(and(eq(items.id, row.id), isNotNull(items.externalTicketId)))
    .returning({ id: items.id });
  if (cleared.length > 0 && row.provider && row.ticketId) {
    void emitEvent(workspace.id, {
      type: "ticket.unlinked",
      workspace: workspace.slug,
      item: { short_id: itemShortId, title: row.title, type: row.type },
      ticket: { provider: row.provider, id: row.ticketId, url: row.ticketUrl },
      at: new Date().toISOString(),
    });
  }

  revalidatePath(`/thread/${itemShortId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

// Whether `provider` can push status updates to this workspace, for the
// Engineering tile. Linear and GitHub sign theirs with a deployment-wide
// secret; on Cloud each Jira install registers its own webhook.
// ponytail: the tile asks on mount; ThreadViewTile could pass this along with
// workspaceIntegrations and save the round trip.
export async function externalStatusSetup(provider: Provider): Promise<{ setUp: boolean; cloud: boolean }> {
  const { workspace } = await getActiveSession();
  const setUp = provider === "linear" ? !!Linear.LINEAR_WEBHOOK_SECRET()
    : provider === "github" ? !!Github.GITHUB_WEBHOOK_SECRET()
    : provider === "jira" && Jira.statusSyncReady(workspace);
  return { setUp, cloud: isCloud() };
}

// The modal's target picker and the Integrations cards' default pickers: the
// connected provider's teams, projects or repos, every page of them, so the UI
// doesn't need to call the provider API from the client.
export async function listProviderTargets(provider: Provider): Promise<
  | { ok: true; targets: Array<{ id: string; label: string }>; defaultTarget: string | null }
  | { ok: false; error: string }
> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  // Checked here too so the modal says why as soon as it opens.
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };

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
// titles from the target provider to give the model the team's voice, and
// ends the body with who is asking, their ARR and a link back to the thread.
// Persists the suggestion (pending) so a future audit can show
// "AI proposed X, vendor edited to Y".
export type SuggestExternalTicketResult =
  | { ok: true; title: string; body: string; labels: string[] | null; reason: string; confidence: number; suggestionId: string }
  | { ok: false; error: string };

// Recent ticket titles from the target, for voice. Best-effort: on failure the
// model still drafts, just less in the team's style.
async function recentTickets(
  workspace: Workspace,
  provider: Provider,
  target: string,
): Promise<Array<{ identifier: string; title: string; stateName: string }>> {
  try {
    if (provider === "linear") return await Linear.listRecentIssues(open(workspace.linearAccessToken!), target, 10);
    if (provider === "jira") return await Jira.listRecentIssues(workspace, target, 10);
    return await Github.listRecentIssues(workspace.githubAppInstallId!, target, 10);
  } catch (err) {
    // Even on this best-effort path, a revoked token should clear the install.
    if (err instanceof IntegrationAuthError) void clearProviderInstall(workspace.id, err.provider);
    log.warn(`listRecentIssues(${provider}) failed (non-fatal)`, { scope: "crumb/ai", err });
    return [];
  }
}

// The item's merge group: distinct accounts asking, their summed ARR, and the
// distinct people asking. Same sums as the thread header.
async function mergeGroupReach(itemId: string): Promise<{ accounts: number; arrCents: number; requesters: number }> {
  const [r] = (await db.execute(sql`
    SELECT COUNT(*)::int AS accts, COALESCE(SUM(a.arr_cents), 0)::bigint AS arr,
      (SELECT COUNT(DISTINCT p.submitter_id) FROM items p WHERE p.id = ${itemId} OR p.merged_into_id = ${itemId})::int AS people
    FROM (SELECT DISTINCT g.account_id FROM items g WHERE g.id = ${itemId} OR g.merged_into_id = ${itemId}) grp
    JOIN accounts a ON a.id = grp.account_id
  `)) as unknown as Array<{ accts: number | string; arr: number | string; people: number | string }>;
  return { accounts: Number(r?.accts ?? 0), arrCents: Number(r?.arr ?? 0), requesters: Number(r?.people ?? 0) };
}

export async function suggestExternalTicket(
  itemShortId: string,
  provider: Provider,
  // The team / project / repo picked in the modal; null means the workspace default.
  target: string | null = null,
): Promise<SuggestExternalTicketResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  if (!ticketSuggestionConfigured()) return { ok: false, error: "not_configured" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };

  const conn = {
    linear: { connected: !!workspace.linearAccessToken, target: target ?? workspace.linearTeamId, missing: "no_team" },
    jira: { connected: !!workspace.jiraAccessToken, target: target ?? workspace.jiraDefaultProjectKey, missing: "no_project" },
    github: { connected: !!workspace.githubAppInstallId, target: target ?? workspace.githubDefaultRepo, missing: "no_repo" },
  }[provider];
  if (!conn) return { ok: false, error: "provider_not_supported" };
  if (!conn.connected) return { ok: false, error: `${provider}_not_connected` };
  const providerTarget = conn.target;
  if (!providerTarget) return { ok: false, error: conn.missing };

  const [item] = await db
    .select({
      id: items.id,
      title: items.title,
      body: items.body,
      type: items.type,
      accountName: accounts.name,
      arrCents: accounts.arrCents,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };
  const origin = originFromHeaders(headers());

  // One metered unit; the entitlement check inside answers not_entitled after
  // a downgrade instead of a misleading "limit reached".
  const budget = await withAiBudget(workspace, async () => {
    // The repo the issue is going to, else the default repo.
    const contextRepo = provider === "github" ? providerTarget : workspace.githubDefaultRepo;
    const [recent, repoContext, reach] = await Promise.all([
      recentTickets(workspace, provider, providerTarget),
      // GitHub repo context feeds *all* providers' drafts when a GitHub repo
      // is connected on this workspace — teams often use GitHub for code +
      // Linear/Jira for tickets, and the model gets the project framing from
      // the README + tree regardless of where the ticket lands.
      workspace.githubAppInstallId && contextRepo
        ? Github.getRepoContext(workspace.githubAppInstallId, contextRepo).catch((err) => {
            log.warn("getRepoContext failed (non-fatal)", { scope: "crumb/ai", err });
            return undefined;
          })
        : undefined,
      mergeGroupReach(item.id),
    ]);
    return suggestTicket({
      provider,
      item: { title: item.title, body: item.body, type: item.type },
      recentTickets: recent,
      repoContext,
      impact: {
        accountName: item.accountName,
        arrCents: item.arrCents,
        accounts: reach.accounts,
        combinedArrCents: reach.arrCents,
        requesters: reach.requesters,
        threadUrl: origin ? `${origin}/thread/${itemShortId}` : null,
      },
    });
  });
  if (!budget.ok) return { ok: false, error: budget.error };
  const draft = budget.value;
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

// Update the workspace-level default target for a provider (the Integrations
// cards' pickers). Stored on workspaces so future creates default to it; the
// default GitHub repo also feeds AI drafts and Slack sizing.
export async function updateProviderDefault(provider: Provider, target: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  if (provider === "linear") {
    if (!workspace.linearAccessToken) return { ok: false, error: "linear_not_connected" };
    // Re-fetch the team name to keep the cached label fresh.
    let teams: Awaited<ReturnType<typeof Linear.listTeams>>;
    try {
      teams = await Linear.listTeams(open(workspace.linearAccessToken));
    } catch (err) {
      return (await handleRevoke(err, workspace.id)) ?? { ok: false, error: "provider_list_failed" };
    }
    const teamName = teams.find(t => t.id === target)?.name;
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

// Who mergeItems would email about folding `sourceShortId` in, and whether it
// goes out, so MergePanel can say so before the vendor confirms. `carried`
// counts the requests already merged into it, which move along with it
// (absent when there are none).
export async function mergeNotice(
  sourceShortId: string,
): Promise<
  | { ok: true; name: string; accountName: string; source: string | null; plan: NotifyPlan; carried?: number }
  | { ok: false; error: string }
> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  const notice = await mergeNoticePlan(workspace.id, sourceShortId);
  if (!notice) return { ok: false, error: "not_found" };
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS carried FROM items d
    JOIN items s ON s.id = d.merged_into_id
    WHERE s.workspace_id = ${workspace.id} AND s.short_id = ${sourceShortId}
  `)) as unknown as Array<{ carried: number | string }>;
  const carried = Number(row?.carried ?? 0);
  return { ok: true, ...notice, ...(carried > 0 ? { carried } : {}) };
}

// Fold `source` into `target` (the canonical). Source becomes status=duplicate
// with merged_into_id set; its replay sessions re-point to the canonical so
// they surface there, and any pending dedupe suggestion resolves. A source
// that is itself a canonical brings its duplicates along: they follow the
// target too, so the group stays one level deep and their customers hear the
// target's outcome. Its submitter is emailed once (notifyMergedItem);
// `emailed` says whether a real provider took it. The group's combined
// ARR/followers are computed at read time (ThreadViewTile), never stored, so
// they stay correct as ARR changes. Admin/pm only.
export async function mergeItems(
  sourceShortId: string,
  targetShortId: string,
): Promise<{ ok: true; emailed: boolean } | { ok: false; error: string }> {
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

  // All or nothing, and at one instant: the source's merged_at, its carried
  // duplicates' merged_at and its history row all get this transaction's
  // now(), which is how unmergeItem tells what came along.
  const carried = await db.transaction(async (tx) => {
    const [folded] = await tx
      .update(items)
      .set({
        status: "duplicate",
        mergedIntoId: target.id,
        mergedAt: sql`now()`,
        mergedByWorkspaceUserId: user.id,
        updatedAt: sql`now()`,
      })
      .where(and(eq(items.id, source.id), or(isNull(items.mergedIntoId), ne(items.mergedIntoId, target.id))))
      .returning({ id: items.id });
    if (!folded) return null;
    // Its own duplicates come along. Their customers were told once, when
    // they were first merged, so nobody is emailed for this.
    const moved = await tx
      .update(items)
      .set({ mergedIntoId: target.id, mergedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(items.workspaceId, workspace.id), eq(items.mergedIntoId, source.id)))
      .returning({ shortId: items.shortId, title: items.title, type: items.type });
    await tx.insert(statusEvents).values({
      itemId: source.id,
      fromStatus: source.status,
      toStatus: "duplicate",
      reason: `Merged into ${targetShortId}`,
      byWorkspaceUserId: user.id,
    });
    // Re-point replay sessions to the canonical item: the source's own and
    // the ones its duplicates brought to it.
    await tx.update(replaySessions).set({ itemId: target.id }).where(eq(replaySessions.itemId, source.id));
    // Resolve any pending dedupe suggestion that proposed this merge.
    await tx
      .update(dedupeSuggestions)
      .set({ status: "accepted", decidedAt: new Date() })
      .where(and(eq(dedupeSuggestions.itemId, source.id), eq(dedupeSuggestions.status, "pending")));
    return moved;
  });
  // Already merged into this target (a repeated submit): nothing changed, so
  // no second timeline row and no second email.
  if (!carried) return { ok: true, emailed: false };

  for (const m of [source, ...carried]) {
    void emitEvent(workspace.id, {
      type: "item.merged",
      workspace: workspace.slug,
      item: { short_id: m.shortId, title: m.title, type: m.type },
      into: { short_id: targetShortId },
      at: new Date().toISOString(),
    });
  }

  // Told once: a request moved here from another canonical item was told when
  // it was first merged.
  const emailed = source.mergedIntoId ? false : await notifyMergedItem(
    { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole },
    { itemShortId: source.shortId, origin: originFromHeaders(headers()) },
  );

  revalidatePath(`/thread/${targetShortId}`);
  revalidatePath(`/thread/${sourceShortId}`);
  revalidatePath("/inbox");
  return { ok: true, emailed };
}

// Reverse a merge: the item stands alone again with the status it had before
// it was merged (from its own history; "open" when there is none, as for a
// duplicate a connector folded in at capture) and takes back its replay
// sessions. A canonical that was merged with its duplicates takes those back
// too. Says which status it went back to and how many came back with it.
export async function unmergeItem(
  shortId: string,
): Promise<{ ok: true; status: string; carried: number } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const [row] = await db
    .select({ id: items.id, status: items.status, mergedIntoId: items.mergedIntoId })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, shortId)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (!row.mergedIntoId) return { ok: false, error: "not_merged" };
  const canonicalId = row.mergedIntoId;
  const [canonical] = await db.select({ shortId: items.shortId }).from(items).where(eq(items.id, canonicalId)).limit(1);

  // Its moves into Duplicate, newest first: it goes back to where the latest
  // one from another status started.
  const merges = await db
    .select({ fromStatus: statusEvents.fromStatus })
    .from(statusEvents)
    .where(and(eq(statusEvents.itemId, row.id), eq(statusEvents.toStatus, "duplicate")))
    .orderBy(desc(statusEvents.at));
  const status = merges.find((e) => e.fromStatus && e.fromStatus !== "duplicate")?.fromStatus ?? "open";

  const carried = await db.transaction(async (tx) => {
    // The duplicates that came along when it was merged share its merged_at,
    // the instant of its own merge row (mergeItems). One carried along by its
    // canonical has no merge row at that instant, so brings nothing back.
    const came = (await tx.execute(sql`
      SELECT d.id FROM items d
      JOIN items x ON x.id = ${row.id}
      WHERE d.merged_into_id = ${canonicalId} AND d.id <> x.id AND d.merged_at = x.merged_at
        AND EXISTS (
          SELECT 1 FROM status_events e
          WHERE e.item_id = x.id AND e.to_status = 'duplicate' AND e.at = x.merged_at
        )
    `)) as unknown as Array<{ id: string }>;
    const cameIds = came.map((c) => c.id);

    // A replay session records only who it belongs to (its account user,
    // stamped when it was linked at submit), not the item it came in with. So
    // a session on the canonical belongs to the group item that person filed
    // first after it started, and the ones belonging to the items leaving
    // come back here. Runs while those items are still in the group.
    // ponytail: attribution by person and time can misplace a session when
    // one person filed two of the group's items from overlapping sessions.
    // Record the origin item on replay_sessions at merge time if that matters.
    await tx
      .update(replaySessions)
      .set({ itemId: row.id })
      .where(and(
        eq(replaySessions.itemId, canonicalId),
        inArray(sql`(
          SELECT g.id FROM items g
          WHERE (g.id = ${canonicalId} OR g.merged_into_id = ${canonicalId})
            AND g.submitter_id = replay_sessions.account_user_id
            AND g.created_at >= replay_sessions.started_at
          ORDER BY g.created_at
          LIMIT 1
        )`, [row.id, ...cameIds]),
      ));

    if (cameIds.length > 0) {
      await tx.update(items).set({ mergedIntoId: row.id, updatedAt: sql`now()` }).where(inArray(items.id, cameIds));
    }
    await tx
      .update(items)
      .set({ status, mergedIntoId: null, mergedAt: null, mergedByWorkspaceUserId: null, updatedAt: sql`now()` })
      .where(eq(items.id, row.id));
    await tx.insert(statusEvents).values({
      itemId: row.id,
      fromStatus: row.status,
      toStatus: status,
      reason: canonical ? `Unmerged from ${canonical.shortId}` : "Unmerged",
      byWorkspaceUserId: user.id,
    });
    return cameIds.length;
  });

  revalidatePath(`/thread/${shortId}`);
  if (canonical) revalidatePath(`/thread/${canonical.shortId}`);
  revalidatePath("/inbox");
  return { ok: true, status, carried };
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
    .select({
      id: items.id,
      accountId: items.accountId,
      title: items.title,
      body: items.body,
      type: items.type,
      status: items.status,
      lang: items.detectedLang,
    })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .limit(1);
  if (!item) return { ok: false, error: "not_found" };

  const [thread, style] = await Promise.all([
    // This thread's customer-visible messages, the latest ten. Internal notes
    // stay out of anything a customer might be sent.
    db
      .select({ body: replies.body, vendorUserId: replies.workspaceUserId })
      .from(replies)
      .where(and(eq(replies.itemId, item.id), eq(replies.internal, false)))
      .orderBy(desc(replies.createdAt))
      .limit(10),
    // The vendor's newest replies on this customer account's other threads,
    // for tone. Never another account's: no other customer's details reach the
    // model. None means draftReply's default tone. Each comes with its thread's
    // account and customer names so draftReply can scrub them out.
    db
      .select({ body: replies.body, accountName: accounts.name, personName: accountUsers.name })
      .from(replies)
      .innerJoin(items, eq(items.id, replies.itemId))
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
      .where(and(
        eq(items.workspaceId, workspace.id),
        eq(items.accountId, item.accountId),
        ne(items.id, item.id),
        isNotNull(replies.workspaceUserId),
        eq(replies.internal, false),
      ))
      .orderBy(desc(replies.createdAt))
      .limit(5),
  ]);

  const budget = await withAiBudget(workspace, () =>
    draftReply({
      item: { title: item.title, body: item.body, type: item.type, status: item.status },
      lang: item.lang,
      thread: thread.reverse().map(r => ({ fromVendor: r.vendorUserId !== null, body: r.body })),
      styleExamples: style.map(s => ({ body: s.body, names: [s.accountName, s.personName] })),
    }),
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
    const [title, body] = await Promise.all([
      translate(item.title, WORKSPACE_LANG),
      item.body ? translate(item.body, WORKSPACE_LANG) : Promise.resolve(""),
    ]);
    return { title, body };
  });
  if (!budget.ok) return { ok: false, error: budget.error };
  const { title, body } = budget.value;
  // Both halves or nothing: saving half a translation showed an empty body (or
  // the original title) as if it had worked.
  if (!title || body === null) return { ok: false, error: "translate_failed" };

  await db
    .update(items)
    .set({ titleTranslated: title, bodyTranslated: body, translatedAt: new Date() })
    .where(eq(items.id, item.id));
  revalidatePath(`/thread/${itemShortId}`);
  return { ok: true };
}
