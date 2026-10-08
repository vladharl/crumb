import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { hubspot } from "@/lib/integrations/crm/hubspot";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { withoutAlert } from "@/lib/integrations/revoke";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// HubSpot redirects here after consent. Same shape as the Linear callback:
// verify state, exchange code, persist sealed tokens (clearing any automatic-
// disconnect alert), start the first account sync in the background and
// redirect straight back. The settings card shows "Syncing…" until it ends.

function redirectBack(req: Request, slug: string): Response {
  return redirectToSettings(req, "hubspot", slug);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return redirectBack(req, `error_${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "hubspot", state);
  if (!v.ok) return v.redirect;

  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, v.workspaceId)).limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let tokens;
  try {
    tokens = await hubspot.exchangeCode(code, callbackUrlFromRequest("hubspot", hubspot.redirectOverride(), req));
  } catch (err) {
    log.error("hubspot code exchange failed", { scope: "crumb/hubspot", err });
    return redirectBack(req, "error_exchange_failed");
  }

  const [fresh] = await db
    .update(workspaces)
    .set({
      hubspotAccessToken: seal(tokens.accessToken),
      hubspotRefreshToken: tokens.refreshToken ? seal(tokens.refreshToken) : null,
      hubspotTokenExpiresAt: tokens.expiresAt,
      hubspotPortalId: tokens.portalId ?? null,
      hubspotInstalledAt: new Date(),
      integrationAlerts: withoutAlert("hubspot"),
    })
    .where(eq(workspaces.id, ws.id))
    .returning();

  // A big portal takes minutes, so the first sync runs after the redirect. It
  // never rejects, and its outcome is shown on the card.
  if (fresh) void syncCrmAccounts(fresh, "hubspot");

  return redirectBack(req, "connected");
}
