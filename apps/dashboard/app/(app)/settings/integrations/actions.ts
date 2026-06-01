"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, workspaces, workspaceUsers } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { integrationsAllowed } from "@/lib/entitlements";
import { callbackUrlFromHeaders } from "@/lib/integrations/callback-url";
import { buildAuthUrl as buildSlackAuthUrl, SLACK_REDIRECT_URL, slackConfigured } from "@/lib/slack/install";
import {
  buildAuthUrl as buildLinearAuthUrl,
  LINEAR_REDIRECT_URL,
  linearConfigured,
} from "@/lib/integrations/linear";
import {
  buildAuthUrl as buildJiraAuthUrl,
  JIRA_REDIRECT_URL,
  jiraConfigured,
} from "@/lib/integrations/jira";
import {
  buildAuthUrl as buildGithubAuthUrl,
  githubConfigured,
} from "@/lib/integrations/github";
import { getCrmAdapter } from "@/lib/integrations/crm";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
import type { CrmProvider } from "@/lib/integrations/crm/types";
import { seal, open } from "@/lib/crypto-at-rest";
import { assertSafeWebhookUrl } from "@/lib/notify/url-guard";
import { postTeamsWebhook, teamsCardFor } from "@/lib/notify/chat";

// The connect actions RETURN an error object for the gating cases (admin,
// plan, creds) instead of throwing: a thrown Error's message is redacted to a
// generic string in production, so the button couldn't tell the user *why* it
// failed. On success they `redirect()` to the provider (which never returns).
type StartResult = { ok: false; error: string };

export async function startSlackInstall(): Promise<StartResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  if (!slackConfigured()) return { ok: false, error: "slack_not_configured" };
  redirect(buildSlackAuthUrl(workspace.id, callbackUrlFromHeaders("slack", SLACK_REDIRECT_URL())));
}

export async function startLinearInstall(): Promise<StartResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  if (!linearConfigured()) return { ok: false, error: "linear_not_configured" };
  redirect(buildLinearAuthUrl(workspace.id, callbackUrlFromHeaders("linear", LINEAR_REDIRECT_URL())));
}

export async function disconnectLinear(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  // Clear the install + any external links that pointed at Linear. Items
  // keep their external_ticket_url so the deep link still works, but the
  // status sync will stop (workspace can no longer call Linear's API).
  await db
    .update(workspaces)
    .set({
      linearAccessToken: null,
      linearTeamId:      null,
      linearTeamName:    null,
      linearInstalledAt: null,
    })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function startJiraInstall(): Promise<StartResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  if (!jiraConfigured()) return { ok: false, error: "jira_not_configured" };
  redirect(buildJiraAuthUrl(workspace.id, callbackUrlFromHeaders("jira", JIRA_REDIRECT_URL())));
}

export async function disconnectJira(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  await db
    .update(workspaces)
    .set({
      jiraAccessToken:       null,
      jiraRefreshToken:      null,
      jiraTokenExpiresAt:    null,
      jiraCloudId:           null,
      jiraSiteUrl:           null,
      jiraDefaultProjectKey: null,
      jiraInstalledAt:       null,
    })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function startGithubInstall(): Promise<StartResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  if (!githubConfigured()) return { ok: false, error: "github_not_configured" };
  // GitHub Apps use a slug-based install URL (no redirect_uri arg — the
  // app's setup URL on GitHub holds the callback config).
  redirect(buildGithubAuthUrl(workspace.id));
}

export async function disconnectGithub(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  await db
    .update(workspaces)
    .set({
      githubAppInstallId:      null,
      githubAppInstallAccount: null,
      githubDefaultRepo:       null,
      githubInstalledAt:       null,
    })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function disconnectSlack(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  await db
    .update(workspaces)
    .set({
      slackTeamId: null,
      slackTeamName: null,
      slackBotToken: null,
      slackBotUserId: null,
      slackInstalledAt: null,
    })
    .where(eq(workspaces.id, workspace.id));

  // Clear cached user_ids — they were tied to the old install and may
  // be wrong if Slack is reconnected later (different team).
  await db
    .update(workspaceUsers)
    .set({ slackUserId: null, slackLookupFailedAt: null })
    .where(eq(workspaceUsers.workspaceId, workspace.id));

  revalidatePath("/settings/integrations");
  revalidatePath("/notifications");
  return { ok: true };
}

// ─── CRM sync (feature 1) ────────────────────────────────────
// Capability-gated like the other integrations: present OAuth-app creds ⇒ the
// connect button works (self-host included). Sync is one-way CRM → accounts+ARR.

export async function startHubspotInstall(): Promise<StartResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  const adapter = getCrmAdapter("hubspot");
  if (!adapter.configured()) return { ok: false, error: "hubspot_not_configured" };
  redirect(adapter.buildAuthUrl(workspace.id, callbackUrlFromHeaders("hubspot", adapter.redirectOverride())));
}

export async function disconnectHubspot(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  await db
    .update(workspaces)
    .set({
      hubspotAccessToken: null,
      hubspotRefreshToken: null,
      hubspotTokenExpiresAt: null,
      hubspotPortalId: null,
      hubspotInstalledAt: null,
    })
    .where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function startSalesforceInstall(): Promise<StartResult> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  const adapter = getCrmAdapter("salesforce");
  if (!adapter.configured()) return { ok: false, error: "salesforce_not_configured" };
  redirect(adapter.buildAuthUrl(workspace.id, callbackUrlFromHeaders("salesforce", adapter.redirectOverride())));
}

export async function disconnectSalesforce(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  await db
    .update(workspaces)
    .set({
      salesforceAccessToken: null,
      salesforceRefreshToken: null,
      salesforceInstanceUrl: null,
      salesforceTokenExpiresAt: null,
      salesforceInstalledAt: null,
    })
    .where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/integrations");
  return { ok: true };
}

// Manual "Sync now". Admin/pm (ARR data, not just a connection). Returns the
// number of accounts upserted so the UI can confirm.
export async function syncCrmNow(
  provider: CrmProvider,
): Promise<{ ok: true; upserted: number } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  const r = await syncCrmAccounts(workspace, provider);
  if (r.ok) {
    revalidatePath("/settings/integrations");
    revalidatePath("/accounts");
  }
  return r;
}

// ─── MS Teams vendor webhook (feature: dual-side notifications) ──────
// Not OAuth — the workspace pastes a Teams "Workflows"/incoming-webhook URL.
// Key events (new submission, customer reply, status change) post a card there.

export async function setTeamsWebhook(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const guard = assertSafeWebhookUrl(url);
  if (!guard.ok) return { ok: false, error: "teams_invalid_url" };
  await db
    .update(workspaces)
    .set({ teamsWebhookUrl: seal(guard.url), teamsConnectedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function disconnectTeams(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  await db
    .update(workspaces)
    .set({ teamsWebhookUrl: null, teamsConnectedAt: null })
    .where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function testTeamsWebhook(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const [ws] = await db
    .select({ teamsWebhookUrl: workspaces.teamsWebhookUrl })
    .from(workspaces)
    .where(eq(workspaces.id, workspace.id))
    .limit(1);
  if (!ws?.teamsWebhookUrl) return { ok: false, error: "not_connected" };
  let url: string;
  try { url = open(ws.teamsWebhookUrl); } catch { return { ok: false, error: "decrypt_failed" }; }
  const r = await postTeamsWebhook(url, teamsCardFor({
    kind: "status_change", shortId: "FB-0", title: "Crumb test card",
    fromStatus: null, toStatus: "open", reason: "This is a test from Crumb.", url: null,
  }));
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "post_failed" };
}

// Toggle session record on/off for the workspace. Cloud-only (the ingest
// route 410s on self-host); the toggle UI still lets admins flip the flag
// — the column exists everywhere so we don't gate the action itself, just
// the visible product. Tier-gating happens at request time, not setting
// time, so a workspace can pre-flip the toggle before upgrading.
export async function setSessionRecordEnabled(
  next: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };

  await db
    .update(workspaces)
    .set({ sessionRecordEnabled: next })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}
