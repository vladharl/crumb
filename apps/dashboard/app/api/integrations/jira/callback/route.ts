import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import {
  ensureWebhook,
  exchangeCode,
  fetchAccessibleResources,
  listProjectsWithToken,
  JIRA_REDIRECT_URL,
} from "@/lib/integrations/jira";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { originFromHeaders } from "@/lib/origin";
import { isCloud } from "@/lib/tier";
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
    .select({ id: workspaces.id })
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
  const target = resources[0];
  if (!target) return redirectBack(req, "error_no_resources");

  // Convenience: if the site has exactly one project, pre-select it as the
  // default so the admin can create tickets immediately. Best-effort — a
  // failure here must not break the connect.
  let defaultProjectKey: string | null = null;
  try {
    const projects = await listProjectsWithToken(target.id, token.access_token);
    if (projects.length === 1) defaultProjectKey = projects[0].key;
  } catch (err) {
    log.warn("jira project pre-select failed (non-fatal)", { scope: "crumb/jira", err });
  }

  await db
    .update(workspaces)
    .set({
      jiraAccessToken:       seal(token.access_token),
      jiraRefreshToken:      seal(token.refresh_token),
      jiraTokenExpiresAt:    new Date(Date.now() + token.expires_in * 1000),
      jiraCloudId:           target.id,
      jiraSiteUrl:           target.url,
      jiraDefaultProjectKey: defaultProjectKey,
      jiraInstalledAt:       new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  // Status sync on Cloud needs this install's own webhook (see ensureWebhook).
  // Like the pre-select it can't undo the connect: on failure the connection
  // stays and the banner says status sync isn't set up.
  if (isCloud()) {
    const hook = await ensureWebhook(
      ws.id,
      { accessToken: token.access_token, cloudId: target.id },
      originFromHeaders(req.headers),
    );
    if (!hook.ok) return redirectBack(req, "connected_no_sync");
  }

  return redirectBack(req, "connected");
}
