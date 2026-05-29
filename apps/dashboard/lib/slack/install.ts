import "server-only";
import { signState, verifyState } from "../integrations/state";

// OAuth v2 — workspace-level install. We request the minimum scopes:
//   chat:write       — post messages as the bot
//   im:write         — open DMs with workspace members
//   users:read       — list members
//   users:read.email — resolve workspace_user.email → slack user_id
//
// Self-host: vendor registers their own Slack app at api.slack.com and
// sets SLACK_CLIENT_ID/SECRET + redirect URL to /api/integrations/slack/callback.
// Cloud: we hold the creds; same code path.
const BOT_SCOPES = "chat:write,im:write,users:read,users:read.email";

export function slackConfigured(): boolean {
  return !!process.env.SLACK_CLIENT_ID?.trim() && !!process.env.SLACK_CLIENT_SECRET?.trim();
}

export const SLACK_CLIENT_ID = () => process.env.SLACK_CLIENT_ID?.trim() ?? null;
export const SLACK_CLIENT_SECRET = () => process.env.SLACK_CLIENT_SECRET?.trim() ?? null;
// Optional override; otherwise build from the request origin at callback time.
export const SLACK_REDIRECT_URL = () => process.env.SLACK_REDIRECT_URL?.trim() ?? null;

// OAuth state HMAC moved to lib/integrations/state.ts so it's shared
// across providers. The state value is provider-keyed; a leaked Slack
// state can't be replayed against Linear/Jira/GitHub.

// Compose the install URL the admin clicks through.
export function buildAuthUrl(workspaceId: string, redirectUrl: string): string {
  const clientId = SLACK_CLIENT_ID();
  if (!clientId) throw new Error("SLACK_CLIENT_ID is not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: BOT_SCOPES,
    redirect_uri: redirectUrl,
    state: signState("slack", workspaceId),
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

// Re-export for the callback route's convenience — keep verifyState as the
// single import alongside exchangeCode on the Slack side. The "slack"
// provider literal is enforced here so callers can't mix providers.
export function verifySlackState(state: string): { ok: true; workspaceId: string } | { ok: false } {
  return verifyState("slack", state);
}

// Slack returns this shape from oauth.v2.access on success.
export type SlackOAuthSuccess = {
  ok: true;
  app_id: string;
  team: { id: string; name: string };
  access_token: string;       // bot token, xoxb-…
  bot_user_id: string;
  scope: string;
};

export async function exchangeCode(code: string, redirectUrl: string): Promise<SlackOAuthSuccess> {
  const clientId = SLACK_CLIENT_ID();
  const clientSecret = SLACK_CLIENT_SECRET();
  if (!clientId || !clientSecret) throw new Error("SLACK_CLIENT_ID/SECRET not configured");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUrl,
  });
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`slack_oauth_failed: ${data.error ?? "unknown"}`);
  return data as SlackOAuthSuccess;
}
