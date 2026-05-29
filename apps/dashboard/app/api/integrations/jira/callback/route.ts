import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import {
  exchangeCode,
  fetchAccessibleResources,
  verifyJiraState,
  JIRA_REDIRECT_URL,
} from "@/lib/integrations/jira";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectBack(req: Request, slug: string): Response {
  const url = new URL(req.url);
  url.pathname = "/settings/integrations";
  url.search = `?jira=${slug}`;
  return NextResponse.redirect(url);
}

function callbackUrl(req: Request): string {
  const override = JIRA_REDIRECT_URL();
  if (override) return override;
  const url = new URL(req.url);
  url.search = "";
  return url.toString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return redirectBack(req, `error_${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = verifyJiraState(state);
  if (!v.ok) return redirectBack(req, "error_bad_state");

  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, v.workspaceId))
    .limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let token;
  try {
    token = await exchangeCode(code, callbackUrl(req));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/jira] code exchange failed:", err);
    return redirectBack(req, "error_exchange_failed");
  }

  // Discover the cloud_id + site URL. This is the Jira-specific extra
  // step; without it the API calls have no /ex/jira/{cloud_id}/ to target.
  let resources;
  try {
    resources = await fetchAccessibleResources(token.access_token);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/jira] accessible-resources failed:", err);
    return redirectBack(req, "error_resources_failed");
  }
  const target = resources[0];
  if (!target) return redirectBack(req, "error_no_resources");

  await db
    .update(workspaces)
    .set({
      jiraAccessToken:    token.access_token,
      jiraRefreshToken:   token.refresh_token,
      jiraTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      jiraCloudId:        target.id,
      jiraSiteUrl:        target.url,
      jiraInstalledAt:    new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
