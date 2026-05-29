"use server";

import { db, items, replies, accountUsers, statusEvents, attachments, workspaces, ticketSuggestions } from "@crumb/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getActiveSession } from "@/lib/server";
import { sendReplyNotification, sendStatusChangeNotification } from "@/lib/email";
import { buildReplyAddress } from "@/lib/reply-token";
import * as Linear from "@/lib/integrations/linear";
import * as Jira from "@/lib/integrations/jira";
import * as Github from "@/lib/integrations/github";
import { suggestTicket, ticketSuggestionConfigured, TICKET_MODEL } from "@/lib/ai/ticket";

function inboundReplyAddressFor(itemShortId: string, signingSecret: string): string | null {
  const domain = process.env.CRUMB_INBOUND_DOMAIN?.trim();
  if (!domain) return null;
  return buildReplyAddress(itemShortId, signingSecret, domain);
}

type Status = "open" | "review" | "planned" | "progress" | "shipped" | "declined" | "deferred" | "duplicate";

const STATUS_LABELS: Record<Status, string> = {
  open:      "Open",
  review:    "In review",
  planned:   "Planned",
  progress:  "In progress",
  shipped:   "Shipped",
  declined:  "Won’t ship",
  deferred:  "Set aside",
  duplicate: "Duplicate",
};

export async function createReply(input: {
  itemShortId: string;
  body: string;
  internal: boolean;
  attachmentIds?: string[];
}) {
  const body = input.body.trim();
  const attachmentIds = (input.attachmentIds ?? []).filter(Boolean);
  // A reply can be just an attachment with no body — accept that.
  if (!body && attachmentIds.length === 0) return { ok: false as const, error: "empty" };

  const { workspace, user } = await getActiveSession();

  // Fetch the item + submitter in one query so we have everything the
  // notification email needs without a second round-trip.
  const [row] = await db
    .select({
      id: items.id,
      title: items.title,
      status: items.status,
      submitterEmail: accountUsers.email,
    })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .limit(1);
  if (!row) return { ok: false as const, error: "not_found" };

  const [created] = await db.insert(replies).values({
    itemId: row.id,
    workspaceUserId: user.id,
    body,
    internal: input.internal,
  }).returning({ id: replies.id });

  // Link any pending attachments the vendor uploaded. Only their own
  // unlinked rows are eligible — protects against attaching another
  // vendor's draft upload by passing a guessed id.
  if (attachmentIds.length > 0 && created) {
    await db
      .update(attachments)
      .set({ replyId: created.id })
      .where(and(
        inArray(attachments.id, attachmentIds),
        isNull(attachments.replyId),
        eq(attachments.uploadedByWorkspaceUserId, user.id),
      ));
  }

  await db.update(items).set({ updatedAt: new Date() }).where(eq(items.id, row.id));

  revalidatePath(`/thread/${input.itemShortId}`);
  revalidatePath("/inbox");

  // Fire the customer notification asynchronously. Don't fail the action
  // if email delivery hiccups — the reply is already in the DB.
  if (!input.internal) {
    try {
      await sendReplyNotification({
        to: row.submitterEmail,
        workspaceName: workspace.name,
        vendorName: user.name,
        itemShortId: input.itemShortId,
        itemTitle: row.title,
        replyBody: body,
        statusLabel: STATUS_LABELS[row.status as Status],
        productUrl: workspace.productUrl,
        inboundReplyAddress: inboundReplyAddressFor(input.itemShortId, workspace.signingSecret),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[crumb/reply] notification failed:", err);
    }
  }

  return { ok: true as const };
}

const ALLOWED: Status[] = ["open", "review", "planned", "progress", "shipped", "declined", "deferred", "duplicate"];

const REASON_REQUIRED: Set<Status> = new Set(["declined", "deferred", "duplicate"]);

export async function updateStatus(input: {
  itemShortId: string;
  status: Status;
  reason?: string;
}) {
  if (!ALLOWED.includes(input.status)) return { ok: false as const, error: "bad_status" };

  const reason = input.reason?.trim() || null;
  if (REASON_REQUIRED.has(input.status) && !reason) {
    return { ok: false as const, error: "reason_required" };
  }

  const { workspace, user } = await getActiveSession();
  const [row] = await db
    .select({
      id: items.id,
      title: items.title,
      currentStatus: items.status,
      submitterEmail: accountUsers.email,
    })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, input.itemShortId)))
    .limit(1);
  if (!row) return { ok: false as const, error: "not_found" };

  // No-op when status hasn't actually changed; avoids spamming the timeline.
  if (row.currentStatus === input.status) {
    return { ok: true as const };
  }

  await db.update(items).set({ status: input.status, updatedAt: new Date() }).where(eq(items.id, row.id));
  await db.insert(statusEvents).values({
    itemId: row.id,
    fromStatus: row.currentStatus,
    toStatus: input.status,
    reason,
    byWorkspaceUserId: user.id,
  });

  revalidatePath(`/thread/${input.itemShortId}`);
  revalidatePath("/inbox");

  // Email the customer; never let a flaky provider undo a status write.
  try {
    await sendStatusChangeNotification({
      to: row.submitterEmail,
      workspaceName: workspace.name,
      vendorName: user.name,
      itemShortId: input.itemShortId,
      itemTitle: row.title,
      fromStatus: row.currentStatus as Status,
      toStatus: input.status,
      reason,
      productUrl: workspace.productUrl,
      inboundReplyAddress: inboundReplyAddressFor(input.itemShortId, workspace.signingSecret),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/status] notification failed:", err);
  }

  return { ok: true as const };
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
      issue = await Linear.createIssue(token, { teamId, title, description: body });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[crumb/linear] createIssue failed:", err);
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
      // eslint-disable-next-line no-console
      console.error("[crumb/jira] createIssue failed:", err);
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
      // eslint-disable-next-line no-console
      console.error("[crumb/github] createIssue failed:", err);
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
      const teams = await Linear.listTeams(token);
      return {
        ok: true,
        targets: teams.map(t => ({ id: t.id, label: `${t.name} (${t.key})` })),
        defaultTarget: workspace.linearTeamId ?? null,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[crumb/linear] listTeams failed:", err);
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
      // eslint-disable-next-line no-console
      console.error("[crumb/jira] listProjects failed:", err);
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
      // eslint-disable-next-line no-console
      console.error("[crumb/github] listInstallationRepos failed:", err);
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
      recentTickets = await Linear.listRecentIssues(workspace.linearAccessToken, workspace.linearTeamId, 10);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[crumb/ai] listRecentIssues(Linear) failed (non-fatal):", err);
    }
  } else if (provider === "jira") {
    if (!workspace.jiraAccessToken || !workspace.jiraDefaultProjectKey) {
      return { ok: false, error: "jira_not_connected" };
    }
    providerTarget = workspace.jiraDefaultProjectKey;
    try {
      recentTickets = await Jira.listRecentIssues(workspace, workspace.jiraDefaultProjectKey, 10);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[crumb/ai] listRecentIssues(Jira) failed (non-fatal):", err);
    }
  } else if (provider === "github") {
    if (!workspace.githubAppInstallId || !workspace.githubDefaultRepo) {
      return { ok: false, error: "github_not_connected" };
    }
    providerTarget = workspace.githubDefaultRepo;
    try {
      recentTickets = await Github.listRecentIssues(workspace.githubAppInstallId, workspace.githubDefaultRepo, 10);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[crumb/ai] listRecentIssues(GitHub) failed (non-fatal):", err);
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
      // eslint-disable-next-line no-console
      console.warn("[crumb/ai] getRepoContext failed (non-fatal):", err);
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
      const teams = await Linear.listTeams(workspace.linearAccessToken);
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
