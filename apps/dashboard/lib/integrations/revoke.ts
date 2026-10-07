import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, workspaces, workspaceUsers, type Workspace } from "@crumb/db";
import { sendIntegrationDisconnected } from "@/lib/email";
import { originFromHeaders } from "@/lib/origin";
import { log } from "@/lib/log";
import type { Provider } from "./state";

// Managed-OAuth revocation handling. When a provider tells us our stored
// credential is dead — a refresh token expired, the Slack app was
// uninstalled, the GitHub App installation was deleted — we clear the
// install so the workspace stops hammering a doomed endpoint and the
// Settings → Integrations page honestly shows "disconnected" (those pages
// gate on `!!ws.<provider>AccessToken` etc.). The vendor just reconnects.
// It doesn't happen silently: the workspace records why (integration_alerts,
// read back by disconnectNotice for a Reconnect banner) and its admins get
// one email.

// Thrown by the integration HTTP layers on an auth failure (401 / invalid
// grant) so callers can distinguish "your token is dead, reconnect" from a
// transient error and trigger clearProviderInstall.
export class IntegrationAuthError extends Error {
  readonly provider: Provider;
  constructor(provider: Provider, detail?: string) {
    super(`integration_auth_failed:${provider}${detail ? `:${detail}` : ""}`);
    this.name = "IntegrationAuthError";
    this.provider = provider;
  }
}

// The token/install columns to null per provider. Nulling the primary token
// is what flips the UI to "not connected".
const COLUMNS_BY_PROVIDER: Record<Provider, Partial<typeof workspaces.$inferInsert>> = {
  slack: { slackTeamId: null, slackTeamName: null, slackBotToken: null, slackBotUserId: null, slackInstalledAt: null },
  linear: { linearAccessToken: null, linearTeamId: null, linearTeamName: null, linearOrganizationId: null, linearInstalledAt: null },
  jira: {
    jiraAccessToken: null, jiraRefreshToken: null, jiraTokenExpiresAt: null,
    jiraCloudId: null, jiraSiteUrl: null, jiraDefaultProjectKey: null, jiraInstalledAt: null,
  },
  github: { githubAppInstallId: null, githubAppInstallAccount: null, githubDefaultRepo: null, githubInstalledAt: null },
  hubspot: {
    hubspotAccessToken: null, hubspotRefreshToken: null, hubspotTokenExpiresAt: null,
    hubspotPortalId: null, hubspotInstalledAt: null, hubspotArrField: null,
  },
  salesforce: {
    salesforceAccessToken: null, salesforceRefreshToken: null, salesforceInstanceUrl: null,
    salesforceTokenExpiresAt: null, salesforceInstalledAt: null, salesforceArrField: null,
  },
};

// The column whose presence means "connected", as the integrations page reads it.
const CONNECTED_BY = {
  slack: "slackBotToken",
  linear: "linearAccessToken",
  jira: "jiraAccessToken",
  github: "githubAppInstallId",
  hubspot: "hubspotAccessToken",
  salesforce: "salesforceAccessToken",
} as const satisfies Record<Provider, keyof Workspace>;

const PROVIDER_NAMES: Record<Provider, string> = {
  slack: "Slack", linear: "Linear", jira: "Jira", github: "GitHub", hubspot: "HubSpot", salesforce: "Salesforce",
};

// What stops working, for the admin email and the Reconnect banner.
const IMPACT: Record<Provider, string> = {
  slack: "Teammates get email instead of Slack DMs, and the /crumb command stops working.",
  linear: "Crumb can't create Linear issues or keep linked ones in sync.",
  jira: "Crumb can't create Jira issues or keep linked ones in sync.",
  github: "Crumb can't create GitHub issues or keep linked ones in sync.",
  hubspot: "Account names and ARR stop refreshing from HubSpot.",
  salesforce: "Account names and ARR stop refreshing from Salesforce.",
};

export async function clearProviderInstall(workspaceId: string, provider: Provider): Promise<void> {
  // Only the call that finds the install still connected disconnects it, so a
  // burst of failures (every DM in a fan-out, say) records and emails once.
  const [ws] = await db
    .update(workspaces)
    .set({
      ...COLUMNS_BY_PROVIDER[provider],
      integrationAlerts: sql`coalesce(${workspaces.integrationAlerts}, '{}'::jsonb) || jsonb_build_object(${provider}::text, jsonb_build_object('reason', 'revoked', 'at', ${new Date().toISOString()}::text))`,
    })
    .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces[CONNECTED_BY[provider]])))
    .returning({ name: workspaces.name });
  if (!ws) return;
  log.warn("cleared revoked integration install", { scope: `crumb/${provider}`, workspaceId, provider });

  if (provider === "slack") {
    // Cached Slack user ids belong to the old install; a reconnect may be a
    // different Slack workspace (same as the manual disconnect).
    await db
      .update(workspaceUsers)
      .set({ slackUserId: null, slackLookupFailedAt: null })
      .where(eq(workspaceUsers.workspaceId, workspaceId));
  }

  try {
    const admins = await db
      .select({ email: workspaceUsers.email })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.workspaceId, workspaceId), eq(workspaceUsers.role, "admin")));
    // No request here, so this is CRUMB_APP_URL or null (never a guessed host).
    const origin = originFromHeaders(new Headers());
    await Promise.all(admins.map((a) => sendIntegrationDisconnected({
      to: a.email,
      workspaceName: ws.name,
      provider: PROVIDER_NAMES[provider],
      impact: IMPACT[provider],
      reconnectUrl: origin ? `${origin}/settings/integrations` : null,
    })));
  } catch (err) {
    log.error("integration disconnect email failed", { scope: `crumb/${provider}`, workspaceId, err });
  }
}

// For a reconnect's workspace update: `integrationAlerts: withoutAlert("slack")`.
export function withoutAlert(provider: Provider) {
  return sql`${workspaces.integrationAlerts} - ${provider}::text`;
}

// The Reconnect banner for an integration Crumb disconnected on its own, or
// null. An alert left over from before a reconnect is ignored, so callbacks
// that don't clear it can't leave a stale banner.
export function disconnectNotice(
  ws: Pick<Workspace, "integrationAlerts" | (typeof CONNECTED_BY)[Provider]>,
  provider: Provider,
): { text: string; at: Date } | null {
  const alert = ws.integrationAlerts?.[provider];
  if (!alert || ws[CONNECTED_BY[provider]]) return null;
  const at = new Date(alert.at);
  const on = Number.isNaN(at.getTime()) ? "" : ` on ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  return {
    at,
    text: `${PROVIDER_NAMES[provider]} was disconnected${on} because it stopped accepting Crumb's access. ${IMPACT[provider]} Reconnect to turn it back on.`,
  };
}

// True for the Slack API error strings that mean "this token is dead".
// chat.postMessage / users.lookupByEmail surface these in the JSON `error`.
const SLACK_REVOKED_ERRORS = new Set(["token_revoked", "account_inactive", "invalid_auth", "not_authed"]);
export function isSlackRevokedError(error: string | undefined): boolean {
  return !!error && SLACK_REVOKED_ERRORS.has(error);
}
