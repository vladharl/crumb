"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, workspaces, workspaceUsers } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { integrationsAllowed } from "@/lib/entitlements";
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

// Resolves the redirect URL a provider will call back to. Honors an
// explicit override env (useful when running behind a tunnel), otherwise
// builds from x-forwarded-host so Cloud picks up the hosted dashboard
// origin without per-deploy config.
function resolveCallbackUrl(provider: "slack" | "linear" | "jira" | "github", override: string | null): string {
  if (override) return override;
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new Error("cannot_resolve_host");
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/integrations/${provider}/callback`;
}

export async function startSlackInstall(): Promise<never> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") throw new Error("forbidden");
  if (!integrationsAllowed(workspace)) throw new Error("plan_required");
  if (!slackConfigured()) throw new Error("slack_not_configured");
  const redirectUrl = resolveCallbackUrl("slack", SLACK_REDIRECT_URL());
  redirect(buildSlackAuthUrl(workspace.id, redirectUrl));
}

export async function startLinearInstall(): Promise<never> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") throw new Error("forbidden");
  if (!integrationsAllowed(workspace)) throw new Error("plan_required");
  if (!linearConfigured()) throw new Error("linear_not_configured");
  const redirectUrl = resolveCallbackUrl("linear", LINEAR_REDIRECT_URL());
  redirect(buildLinearAuthUrl(workspace.id, redirectUrl));
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

export async function startJiraInstall(): Promise<never> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") throw new Error("forbidden");
  if (!integrationsAllowed(workspace)) throw new Error("plan_required");
  if (!jiraConfigured()) throw new Error("jira_not_configured");
  const redirectUrl = resolveCallbackUrl("jira", JIRA_REDIRECT_URL());
  redirect(buildJiraAuthUrl(workspace.id, redirectUrl));
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

export async function startGithubInstall(): Promise<never> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") throw new Error("forbidden");
  if (!integrationsAllowed(workspace)) throw new Error("plan_required");
  if (!githubConfigured()) throw new Error("github_not_configured");
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
