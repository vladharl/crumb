import "server-only";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { originFromHeaders } from "@/lib/origin";
import { verifyState, type Provider } from "./state";

// Shared state/session/redirect handling for the integration OAuth and
// App-install callbacks (app/api/integrations/*/callback).
//
// A valid state only proves Crumb issued the consent link, not that the
// browser finishing it belongs to the admin who started it. Without a session
// check, an attacker could send a victim admin a link carrying the attacker's
// own state and bind the victim's HubSpot/Slack/... to the attacker's
// workspace. So the callback also requires a dashboard session in the state's
// workspace with the role the start*Install actions require. The provider's
// redirect back is a top-level GET, so the SameSite=Lax crumb_session cookie
// rides along.
//
// Redirects target the public origin (CRUMB_APP_URL): behind the tunnel
// req.url is the internal 0.0.0.0:3000 address.

function publicUrl(req: Request, path: string): URL {
  return new URL(path, originFromHeaders(req.headers) ?? req.url);
}

// `/settings/integrations?{provider}={slug}`. Callers encode any
// provider-supplied part of the slug.
export function redirectToSettings(req: Request, provider: Provider, slug: string): Response {
  const url = publicUrl(req, "/settings/integrations");
  url.search = `?${provider}=${slug}`;
  return NextResponse.redirect(url);
}

export async function verifyCallback(
  req: Request,
  provider: Provider,
  state: string,
): Promise<{ ok: true; workspaceId: string; userId: string } | { ok: false; redirect: Response }> {
  const v = verifyState(provider, state);
  if (!v.ok) return { ok: false, redirect: redirectToSettings(req, provider, "error_bad_state") };

  const session = await getSession();
  if (!session) return { ok: false, redirect: NextResponse.redirect(publicUrl(req, "/login")) };
  if (session.workspace.id !== v.workspaceId) {
    return { ok: false, redirect: redirectToSettings(req, provider, "error_wrong_workspace") };
  }
  // Same gate as the start*Install actions (settings/integrations/actions.ts).
  if (session.user.role !== "admin") {
    return { ok: false, redirect: redirectToSettings(req, provider, "error_forbidden") };
  }
  return { ok: true, workspaceId: v.workspaceId, userId: session.user.id };
}
