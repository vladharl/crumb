import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { exchangeCode, verifySlackState, SLACK_REDIRECT_URL } from "@/lib/slack/install";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Slack redirects here after the admin grants scopes. We:
//   1. verify ?state matches the workspace we issued for (HMAC)
//   2. exchange ?code for a bot token
//   3. persist the token + team metadata on the workspace
//   4. send the admin back to /settings/integrations with a result flag

function redirectBack(req: Request, slug: string): Response {
  const url = new URL(req.url);
  url.pathname = "/settings/integrations";
  url.search = `?slack=${slug}`;
  return NextResponse.redirect(url);
}

function callbackUrl(req: Request): string {
  const override = SLACK_REDIRECT_URL();
  if (override) return override;
  const url = new URL(req.url);
  // Drop query string before round-tripping back to Slack's token endpoint
  // — Slack matches the exact redirect_uri sent on the auth step.
  url.search = "";
  return url.toString();
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

  const v = verifySlackState(state);
  if (!v.ok) return redirectBack(req, "error_bad_state");

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
    result = await exchangeCode(code, callbackUrl(req));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/slack] code exchange failed:", err);
    return redirectBack(req, "error_exchange_failed");
  }

  await db
    .update(workspaces)
    .set({
      slackTeamId: result.team.id,
      slackTeamName: result.team.name,
      slackBotToken: result.access_token,
      slackBotUserId: result.bot_user_id,
      slackInstalledAt: new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
