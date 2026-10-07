import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { hubspot } from "@/lib/integrations/crm/hubspot";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// HubSpot redirects here after consent. Same shape as the Linear callback:
// verify state, exchange code, persist sealed tokens, then run an initial
// account+ARR sync so the user sees data immediately, and redirect back.

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

  await db
    .update(workspaces)
    .set({
      hubspotAccessToken: seal(tokens.accessToken),
      hubspotRefreshToken: tokens.refreshToken ? seal(tokens.refreshToken) : null,
      hubspotTokenExpiresAt: tokens.expiresAt,
      hubspotPortalId: tokens.portalId ?? null,
      hubspotInstalledAt: new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  // Initial sync (best-effort) — re-read the row so it has the sealed tokens.
  try {
    const [fresh] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1);
    if (fresh) await syncCrmAccounts(fresh, "hubspot");
  } catch (err) {
    log.warn("hubspot initial sync failed (non-fatal)", { scope: "crumb/hubspot", err });
  }

  return redirectBack(req, "connected");
}
