import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import {
  exchangeCode,
  fetchInstallInfo,
  LINEAR_REDIRECT_URL,
} from "@/lib/integrations/linear";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { withoutAlert } from "@/lib/integrations/revoke";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Linear redirects here after the admin grants scopes. Same shape as the
// Slack callback (verify state, exchange code, persist tokens, redirect
// back to settings with a status flag). One extra step: look up the Linear
// org (the status webhook is scoped by it) and the default team, so the
// workspace lands in a usable state.

function redirectBack(req: Request, slug: string): Response {
  return redirectToSettings(req, "linear", slug);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    return redirectBack(req, `error_${encodeURIComponent(error)}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "linear", state);
  if (!v.ok) return v.redirect;

  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, v.workspaceId))
    .limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let token;
  try {
    token = await exchangeCode(code, callbackUrlFromRequest("linear", LINEAR_REDIRECT_URL(), req));
  } catch (err) {
    log.error("linear code exchange failed", { scope: "crumb/linear", err });
    return redirectBack(req, "error_exchange_failed");
  }

  // Non-fatal: with no Linear teams the install still completes (vendors pick
  // a team in settings later), and with no org id the webhook scopes this
  // install's updates by the org's URL key instead.
  let info: Awaited<ReturnType<typeof fetchInstallInfo>> | null = null;
  try {
    info = await fetchInstallInfo(token.access_token);
  } catch (err) {
    log.warn("linear org and team discovery failed (non-fatal)", { scope: "crumb/linear", err });
  }

  await db
    .update(workspaces)
    .set({
      linearAccessToken: seal(token.access_token),
      linearTeamId:      info?.team?.id   ?? null,
      linearTeamName:    info?.team?.name ?? null,
      // Set on every connect: a reconnect may point at a different Linear org.
      linearOrganizationId: info?.organizationId ?? null,
      linearInstalledAt: new Date(),
      integrationAlerts: withoutAlert("linear"),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
