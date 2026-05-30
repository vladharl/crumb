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
