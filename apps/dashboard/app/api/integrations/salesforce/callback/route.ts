import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { salesforce } from "@/lib/integrations/crm/salesforce";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { withoutAlert } from "@/lib/integrations/revoke";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Salesforce redirects here after consent. Stores the per-org instance_url
// alongside the tokens (every REST call is scoped to it), clears any
// automatic-disconnect alert, starts the first account sync in the background
// and redirects straight back. The settings card shows "Syncing…" until it ends.

function redirectBack(req: Request, slug: string): Response {
  return redirectToSettings(req, "salesforce", slug);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return redirectBack(req, `error_${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "salesforce", state);
  if (!v.ok) return v.redirect;

  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, v.workspaceId)).limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let tokens;
  try {
    tokens = await salesforce.exchangeCode(code, callbackUrlFromRequest("salesforce", salesforce.redirectOverride(), req));
  } catch (err) {
    log.error("salesforce code exchange failed", { scope: "crumb/salesforce", err });
    return redirectBack(req, "error_exchange_failed");
  }

  const [fresh] = await db
    .update(workspaces)
    .set({
      salesforceAccessToken: seal(tokens.accessToken),
      salesforceRefreshToken: tokens.refreshToken ? seal(tokens.refreshToken) : null,
      salesforceInstanceUrl: tokens.instanceUrl ?? null,
      salesforceTokenExpiresAt: tokens.expiresAt,
      salesforceInstalledAt: new Date(),
      integrationAlerts: withoutAlert("salesforce"),
    })
    .where(eq(workspaces.id, ws.id))
    .returning();

  // A big org takes minutes, so the first sync runs after the redirect. It
  // never rejects, and its outcome is shown on the card.
  if (fresh) void syncCrmAccounts(fresh, "salesforce");

  return redirectBack(req, "connected");
}
