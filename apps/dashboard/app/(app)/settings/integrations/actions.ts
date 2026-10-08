"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db, workspaces, workspaceUsers } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { integrationsAllowed } from "@/lib/entitlements";
import { originFromHeaders } from "@/lib/origin";
import { callbackUrlFromHeaders } from "@/lib/integrations/callback-url";
import { buildAuthUrl as buildSlackAuthUrl, SLACK_REDIRECT_URL, slackConfigured } from "@/lib/slack/install";
import {
  buildAuthUrl as buildLinearAuthUrl,
  LINEAR_REDIRECT_URL,
  linearConfigured,
} from "@/lib/integrations/linear";
import { IntegrationAuthError, withoutAlert } from "@/lib/integrations/revoke";
import {
  buildAuthUrl as buildJiraAuthUrl,
  JIRA_REDIRECT_URL,
  jiraConfigured,
  jiraSites,
  setUpSite,
} from "@/lib/integrations/jira";
import {
  buildAuthUrl as buildGithubAuthUrl,
  githubConfigured,
} from "@/lib/integrations/github";
import { getCrmAdapter } from "@/lib/integrations/crm";
import { crmSyncState, syncCrmAccounts } from "@/lib/integrations/crm/sync";
import { safeFieldName, type CrmField, type CrmProvider } from "@/lib/integrations/crm/types";
import { log } from "@/lib/log";
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
      linearOrganizationId: null,
      linearInstalledAt: null,
      integrationAlerts: withoutAlert("linear"),
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
      integrationAlerts:     withoutAlert("jira"),
    })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/settings/integrations");
  return { ok: true };
}

function jiraSitesFailed(err: unknown, workspaceId: string): { ok: false; error: string } {
  // A dead refresh token has already cleared the install.
  if (err instanceof IntegrationAuthError) return { ok: false, error: "revoked" };
  log.error("jira site list failed", { scope: "crumb/jira", workspaceId, err });
  return { ok: false, error: "list_failed" };
}

// The Jira sites the connected Atlassian login reaches, for the picker a login
// with several gets after connecting. Admin only.
export async function listJiraSites(): Promise<
  | { ok: true; sites: Array<{ id: string; name: string; url: string }> }
  | { ok: false; error: string }
> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  try {
    const r = await jiraSites(workspace);
    if (!r) return { ok: false, error: "not_connected" };
    return { ok: true, sites: r.sites.map(s => ({ id: s.id, name: s.name, url: s.url })) };
  } catch (err) {
    return jiraSitesFailed(err, workspace.id);
  }
}

// Finish connecting Jira on the site the admin picked, which must be one this
// workspace's own login reaches: the default project, and on Cloud the
// status webhook (its outcome shows on the card).
export async function setJiraSite(cloudId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  // The rest of connecting, so gated like the Connect button.
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  let r: Awaited<ReturnType<typeof jiraSites>>;
  try {
    r = await jiraSites(workspace);
  } catch (err) {
    return jiraSitesFailed(err, workspace.id);
  }
  if (!r) return { ok: false, error: "not_connected" };
  const site = r.sites.find(s => s.id === cloudId);
  if (!site) return { ok: false, error: "site_not_found" };

  await db
    .update(workspaces)
    // Another site's projects are different: drop a default chosen on the old one.
    .set({
      jiraCloudId: site.id, jiraSiteUrl: site.url, jiraInstalledAt: new Date(),
      ...(workspace.jiraCloudId !== site.id ? { jiraDefaultProjectKey: null } : {}),
    })
    .where(eq(workspaces.id, workspace.id));
  await setUpSite(workspace.id, { accessToken: r.accessToken, cloudId: site.id }, originFromHeaders(headers()));
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
      integrationAlerts:       withoutAlert("github"),
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
      integrationAlerts: withoutAlert("slack"),
    })
    .where(eq(workspaces.id, workspace.id));

  // Clear cached user_ids — they were tied to the old install and may
  // be wrong if Slack is reconnected later (different team).
  await db
    .update(workspaceUsers)
    .set({ slackUserId: null, slackLookupFailedAt: null })
    .where(eq(workspaceUsers.workspaceId, workspace.id));

  revalidatePath("/settings/integrations");
  revalidatePath("/settings/notifications");
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
      hubspotArrField: null,
      integrationAlerts: withoutAlert("hubspot"),
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
      salesforceArrField: null,
      integrationAlerts: withoutAlert("salesforce"),
    })
    .where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/integrations");
  return { ok: true };
}

// Manual "Sync now". Admin/pm (ARR data, not just a connection). Starts the
// sync and returns: a big CRM takes minutes, longer than a proxy waits for a
// response. The card polls getCrmCardStatus and refreshes when it ends.
export async function syncCrmNow(
  provider: CrmProvider,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };
  if (provider !== "hubspot" && provider !== "salesforce") return { ok: false, error: "not_found" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  if (!getCrmAdapter(provider).configured()) return { ok: false, error: "not_configured" };
  void syncCrmAccounts(workspace, provider); // never rejects
  return { ok: true };
}

// The CRM's number and currency fields, for the ARR field picker. Admin only.
export async function listCrmArrFields(
  provider: CrmProvider,
): Promise<{ ok: true; fields: CrmField[] } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (provider !== "hubspot" && provider !== "salesforce") return { ok: false, error: "not_found" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  try {
    const fields = await getCrmAdapter(provider).numberFields(workspace);
    return { ok: true, fields: fields.sort((a, b) => a.label.localeCompare(b.label)) };
  } catch (err) {
    if (err instanceof IntegrationAuthError) return { ok: false, error: "revoked" };
    log.error("crm field list failed", { scope: `crumb/${provider}`, workspaceId: workspace.id, err });
    return { ok: false, error: "list_failed" };
  }
}

// Choose the field each company's ARR syncs from, then sync with it. Admin
// only. The name lands in a SOQL query and a URL, so only plain API names.
export async function setCrmArrField(
  provider: CrmProvider,
  field: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  if (provider !== "hubspot" && provider !== "salesforce") return { ok: false, error: "not_found" };
  if (!integrationsAllowed(workspace)) return { ok: false, error: "plan_required" };
  const name = typeof field === "string" ? safeFieldName(field) : null;
  if (!name) return { ok: false, error: "invalid_field" };
  const [updated] = await db
    .update(workspaces)
    .set(provider === "hubspot" ? { hubspotArrField: name } : { salesforceArrField: name })
    .where(eq(workspaces.id, workspace.id))
    .returning();
  if (updated) {
    // A sync already going (often the first one after connecting) started
    // without this field, and this call joins it: sync again once it ends.
    const joined = crmSyncState(updated.id, provider).running;
    const run = syncCrmAccounts(updated, provider); // never rejects
    if (joined) void run.then(() => syncCrmAccounts(updated, provider));
  }
  revalidatePath("/settings/integrations");
  return { ok: true };
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
