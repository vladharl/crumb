import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces, type Workspace } from "@crumb/db";
import { signState } from "../integrations/state";
import { log } from "../log";

// OAuth v2 — workspace-level install. We request the minimum scopes:
//   chat:write        — post messages as the bot
//   im:write          — open DMs with workspace members
//   users:read        — list members
//   users:read.email  — resolve workspace_user.email → slack user_id
//   app_mentions:read — receive app_mention events (Phase-0 sizing bot)
//
// Self-host: vendor registers their own Slack app at api.slack.com and
// sets SLACK_CLIENT_ID/SECRET + redirect URL to /api/integrations/slack/callback.
// Cloud: we hold the creds; same code path. Adding a scope requires connected
// workspaces to re-connect (the callback overwrites the token + scopes).
const BOT_SCOPES = "chat:write,im:write,users:read,users:read.email,app_mentions:read";

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

// Slack team → the Crumb workspace that installed it, for the events, commands
// and interactivity routes. The callback keeps a team to one workspace, but
// rows from before that guard (or two claims racing it) can still share one;
// such a team routes nowhere rather than to whichever tenant Postgres returns
// first.
export async function workspaceForSlackTeam(teamId: string): Promise<Workspace | null> {
  const rows = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, teamId)).limit(2);
  if (rows.length > 1) log.warn("slack team held by more than one workspace", { scope: "crumb/slack", teamId });
  return rows.length === 1 ? rows[0] : null;
}
