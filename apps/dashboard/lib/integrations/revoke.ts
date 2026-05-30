import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { log } from "@/lib/log";
import type { Provider } from "./state";

// Managed-OAuth revocation handling. When a provider tells us our stored
// credential is dead — a refresh token expired, the Slack app was
// uninstalled, the GitHub App installation was deleted — we clear the
// install so the workspace stops hammering a doomed endpoint and the
// Settings → Integrations page honestly shows "disconnected" (those pages
// gate on `!!ws.<provider>AccessToken` etc.). The vendor just reconnects.

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
  linear: { linearAccessToken: null, linearTeamId: null, linearTeamName: null, linearInstalledAt: null },
  jira: {
    jiraAccessToken: null, jiraRefreshToken: null, jiraTokenExpiresAt: null,
    jiraCloudId: null, jiraSiteUrl: null, jiraDefaultProjectKey: null, jiraInstalledAt: null,
  },
  github: { githubAppInstallId: null, githubAppInstallAccount: null, githubDefaultRepo: null, githubInstalledAt: null },
};

export async function clearProviderInstall(workspaceId: string, provider: Provider): Promise<void> {
  await db.update(workspaces).set(COLUMNS_BY_PROVIDER[provider]).where(eq(workspaces.id, workspaceId));
  log.warn("cleared revoked integration install", { scope: `crumb/${provider}`, workspaceId, provider });
}

// True for the Slack API error strings that mean "this token is dead".
// chat.postMessage / users.lookupByEmail surface these in the JSON `error`.
const SLACK_REVOKED_ERRORS = new Set(["token_revoked", "account_inactive", "invalid_auth", "not_authed"]);
export function isSlackRevokedError(error: string | undefined): boolean {
  return !!error && SLACK_REVOKED_ERRORS.has(error);
}
