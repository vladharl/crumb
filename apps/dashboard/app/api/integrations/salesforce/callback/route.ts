import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { salesforce } from "@/lib/integrations/crm/salesforce";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
import { verifyState } from "@/lib/integrations/state";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { seal } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Salesforce redirects here after consent. Stores the per-org instance_url
// alongside the tokens (every REST call is scoped to it), then runs an initial
// account+ARR sync.

function redirectBack(req: Request, slug: string): Response {
  const url = new URL(req.url);
  url.pathname = "/settings/integrations";
  url.search = `?salesforce=${slug}`;
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return redirectBack(req, `error_${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectBack(req, "error_missing_params");

  const v = verifyState("salesforce", state);
  if (!v.ok) return redirectBack(req, "error_bad_state");

  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, v.workspaceId)).limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let tokens;
  try {
    tokens = await salesforce.exchangeCode(code, callbackUrlFromRequest("salesforce", salesforce.redirectOverride(), req));
  } catch (err) {
    log.error("salesforce code exchange failed", { scope: "crumb/salesforce", err });
    return redirectBack(req, "error_exchange_failed");
  }

  await db
    .update(workspaces)
    .set({
      salesforceAccessToken: seal(tokens.accessToken),
      salesforceRefreshToken: tokens.refreshToken ? seal(tokens.refreshToken) : null,
      salesforceInstanceUrl: tokens.instanceUrl ?? null,
      salesforceTokenExpiresAt: tokens.expiresAt,
      salesforceInstalledAt: new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  try {
    const [fresh] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1);
    if (fresh) await syncCrmAccounts(fresh, "salesforce");
  } catch (err) {
    log.warn("salesforce initial sync failed (non-fatal)", { scope: "crumb/salesforce", err });
  }

  return redirectBack(req, "connected");
}
