import { and, eq, ne } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { exchangeCode, SLACK_REDIRECT_URL } from "@/lib/slack/install";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Slack redirects here after the admin grants scopes. We:
//   1. verify ?state (HMAC, unexpired) and that the signed-in admin owns
//      the workspace it was issued for
//   2. exchange ?code for a bot token
//   3. refuse a Slack team another workspace already holds
//   4. persist the token + team metadata on the workspace
//   5. send the admin back to /settings/integrations with a result flag

function redirectBack(req: Request, slug: string): Response {
  return redirectToSettings(req, "slack", slug);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    // User clicked Cancel on Slack's grant page, or scope mismatch, etc.
    return redirectBack(req, `error_${encodeURIComponent(error)}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "slack", state);
  if (!v.ok) return v.redirect;

  // Look up the workspace early to make sure it still exists before
  // burning the (single-use) auth code.
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, v.workspaceId))
    .limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let result;
  try {
    result = await exchangeCode(code, callbackUrlFromRequest("slack", SLACK_REDIRECT_URL(), req));
  } catch (err) {
    log.error("slack code exchange failed", { scope: "crumb/slack", err });
    return redirectBack(req, "error_exchange_failed");
  }

  // One Crumb workspace per Slack team: the events, commands and interactivity
  // routes find their tenant by team id. Reconnecting the holder is fine. The
  // bot token belongs to the team's install, which the holder shares, so it is
  // dropped here, not revoked.
  // ponytail: check-then-write, no unique index (no migration). A race leaves
  // the team held twice, which workspaceForSlackTeam routes nowhere; a partial
  // unique index on slack_team_id closes it.
  const [holder] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.slackTeamId, result.team.id), ne(workspaces.id, ws.id)))
    .limit(1);
  if (holder) {
    log.warn("slack team already connected to another workspace", { scope: "crumb/slack", teamId: result.team.id, workspaceId: ws.id });
    return redirectBack(req, "error_team_already_connected");
  }

  await db
    .update(workspaces)
    .set({
      slackTeamId: result.team.id,
      slackTeamName: result.team.name,
      slackBotToken: seal(result.access_token),
      slackBotUserId: result.bot_user_id,
      slackInstalledAt: new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
