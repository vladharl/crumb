import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import {
  exchangeCode,
  verifyLinearState,
  fetchDefaultTeam,
  LINEAR_REDIRECT_URL,
} from "@/lib/integrations/linear";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Linear redirects here after the admin grants scopes. Same shape as the
// Slack callback (verify state, exchange code, persist tokens, redirect
// back to settings with a status flag). One extra step: fetch the
// default team so the workspace lands in a usable state.

function redirectBack(req: Request, slug: string): Response {
  const url = new URL(req.url);
  url.pathname = "/settings/integrations";
  url.search = `?linear=${slug}`;
  return NextResponse.redirect(url);
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

  const v = verifyLinearState(state);
  if (!v.ok) return redirectBack(req, "error_bad_state");

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

  // Discover the default team. If the workspace has no Linear teams the
  // install still completes — vendors can pick a team in settings later.
  let team: { id: string; name: string } | null = null;
  try {
    team = await fetchDefaultTeam(token.access_token);
  } catch (err) {
    log.warn("linear team discovery failed (non-fatal)", { scope: "crumb/linear", err });
  }

  await db
    .update(workspaces)
    .set({
      linearAccessToken: seal(token.access_token),
      linearTeamId:      team?.id   ?? null,
      linearTeamName:    team?.name ?? null,
      // A reconnect may point at a different Linear org; the webhook
      // resolves the new one from this token (resolveOrganizationIds).
      linearOrganizationId: null,
      linearInstalledAt: new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
