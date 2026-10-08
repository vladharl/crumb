import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import {
  exchangeCode,
  fetchAccessibleResources,
  pickSite,
  setUpSite,
  JIRA_REDIRECT_URL,
} from "@/lib/integrations/jira";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { withoutAlert } from "@/lib/integrations/revoke";
import { originFromHeaders } from "@/lib/origin";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectBack(req: Request, slug: string): Response {
  return redirectToSettings(req, "jira", slug);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return redirectBack(req, `error_${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "jira", state);
  if (!v.ok) return v.redirect;

  const [ws] = await db
    .select({ id: workspaces.id, jiraCloudId: workspaces.jiraCloudId })
    .from(workspaces)
    .where(eq(workspaces.id, v.workspaceId))
    .limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let token;
  try {
    token = await exchangeCode(code, callbackUrlFromRequest("jira", JIRA_REDIRECT_URL(), req));
  } catch (err) {
    log.error("jira code exchange failed", { scope: "crumb/jira", err });
    return redirectBack(req, "error_exchange_failed");
  }

  // Discover the cloud_id + site URL. This is the Jira-specific extra
  // step; without it the API calls have no /ex/jira/{cloud_id}/ to target.
  let resources;
  try {
    resources = await fetchAccessibleResources(token.access_token);
  } catch (err) {
    log.error("jira accessible-resources failed", { scope: "crumb/jira", err });
    return redirectBack(req, "error_resources_failed");
  }
  if (resources.length === 0) return redirectBack(req, "error_no_resources");
  // A reconnect keeps its site while the login still reaches it. Otherwise a
  // login that reaches several sites leaves the choice to the admin: the Jira
  // card lists them, and picking one (setJiraSite) finishes the connect.
  const site = pickSite(resources, ws.jiraCloudId);

  await db
    .update(workspaces)
    .set({
      jiraAccessToken:       seal(token.access_token),
      jiraRefreshToken:      seal(token.refresh_token),
      jiraTokenExpiresAt:    new Date(Date.now() + token.expires_in * 1000),
      jiraCloudId:           site?.id ?? null,
      jiraSiteUrl:           site?.url ?? null,
      // The admin's default project stays with its site.
      ...(site && site.id === ws.jiraCloudId ? {} : { jiraDefaultProjectKey: null }),
      // Stamped once tickets have somewhere to go; the thread offers Jira from then.
      jiraInstalledAt:       site ? new Date() : null,
      integrationAlerts:     withoutAlert("jira"),
    })
    .where(eq(workspaces.id, ws.id));
  if (!site) return redirectBack(req, "pick_site");

  // The default project, and on Cloud the status webhook (see ensureWebhook).
  // Neither can undo the connect: on failure the connection stays and the
  // banner says status sync isn't set up.
  const synced = await setUpSite(
    ws.id,
    { accessToken: token.access_token, cloudId: site.id },
    originFromHeaders(req.headers),
  );
  return redirectBack(req, synced ? "connected" : "connected_no_sync");
}
