import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces, type Workspace } from "@crumb/db";
import { signState } from "../state";
import { seal, open } from "../../crypto-at-rest";
import { clearProviderInstall, IntegrationAuthError } from "../revoke";
import { log } from "@/lib/log";
import type { CrmAdapter, CrmCompany, CrmTokens } from "./types";
import { dollarsToArrCents } from "./types";

// HubSpot OAuth 2.0 + CRM v3. Docs:
//   https://developers.hubspot.com/docs/api/oauth-quickstart-guide
//   https://developers.hubspot.com/docs/api/crm/companies
// Read-only: scope crm.objects.companies.read. Tokens are short-lived (~30m)
// with a long-lived refresh token, so we refresh proactively like Jira.

const AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const API_BASE = "https://api.hubapi.com";
const SCOPES = "crm.objects.companies.read oauth";
// The HubSpot company property to read ARR from. Override per deployment.
const ARR_PROPERTY = () => process.env.HUBSPOT_ARR_PROPERTY?.trim() || "annualrevenue";

function clientId() { return process.env.HUBSPOT_CLIENT_ID?.trim() || null; }
function clientSecret() { return process.env.HUBSPOT_CLIENT_SECRET?.trim() || null; }

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

export const hubspot: CrmAdapter = {
  provider: "hubspot",

  configured() {
    return !!clientId() && !!clientSecret();
  },

  redirectOverride() {
    return process.env.HUBSPOT_REDIRECT_URL?.trim() || null;
  },

  buildAuthUrl(workspaceId, redirectUrl) {
    const id = clientId();
    if (!id) throw new Error("HUBSPOT_CLIENT_ID is not configured");
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUrl,
      scope: SCOPES,
      state: signState("hubspot", workspaceId),
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUrl): Promise<CrmTokens> {
    const id = clientId();
    const secret = clientSecret();
    if (!id || !secret) throw new Error("HUBSPOT creds not configured");
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: id,
        client_secret: secret,
        redirect_uri: redirectUrl,
        code,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`hubspot_token_exchange_failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const token = (await resp.json()) as TokenResponse;
    const portalId = await fetchPortalId(token.access_token);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      portalId,
    };
  },

  async listCompaniesWithArr(workspace): Promise<CrmCompany[]> {
    const token = await getValidToken(workspace);
    if (!token) return [];
    const prop = ARR_PROPERTY();
    const out: CrmCompany[] = [];
    let after: string | undefined;
    // Bound the sweep so a huge portal can't run unbounded (20 pages × 100).
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${API_BASE}/crm/v3/objects/companies`);
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", `name,${prop}`);
      if (after) url.searchParams.set("after", after);
      const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (resp.status === 401) {
        await clearProviderInstall(workspace.id, "hubspot");
        throw new IntegrationAuthError("hubspot", "401");
      }
      if (!resp.ok) {
        log.error("hubspot list companies failed", { scope: "crumb/hubspot", status: resp.status });
        break;
      }
      const data = (await resp.json()) as {
        results?: Array<{ id: string; properties?: Record<string, string | null> }>;
        paging?: { next?: { after?: string } };
      };
      for (const c of data.results ?? []) {
        const name = c.properties?.name?.trim();
        if (!name) continue;
        out.push({ externalId: c.id, name, arrCents: dollarsToArrCents(c.properties?.[prop]) });
      }
      after = data.paging?.next?.after;
      if (!after) break;
    }
    return out;
  },
};

// HubSpot's per-token portal lookup, used to label the connected account.
async function fetchPortalId(accessToken: string): Promise<string | null> {
  try {
    const resp = await fetch(`${API_BASE}/oauth/v1/access-tokens/${accessToken}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { hub_id?: number | string };
    return data.hub_id != null ? String(data.hub_id) : null;
  } catch {
    return null;
  }
}

// Valid access token, refreshing (and persisting) when within 60s of expiry.
async function getValidToken(workspace: Workspace): Promise<string | null> {
  if (!workspace.hubspotAccessToken || !workspace.hubspotRefreshToken) return null;
  const expSoon =
    !workspace.hubspotTokenExpiresAt ||
    workspace.hubspotTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expSoon) return open(workspace.hubspotAccessToken);
  return refreshToken(workspace.id, open(workspace.hubspotRefreshToken));
}

async function refreshToken(workspaceId: string, currentRefreshToken: string): Promise<string> {
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) throw new Error("HUBSPOT creds not configured");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: id,
      client_secret: secret,
      refresh_token: currentRefreshToken,
    }),
  });
  if (!resp.ok) {
    if (resp.status === 400 || resp.status === 401) {
      await clearProviderInstall(workspaceId, "hubspot");
      throw new IntegrationAuthError("hubspot", String(resp.status));
    }
    const text = await resp.text();
    throw new Error(`hubspot_refresh_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const token = (await resp.json()) as TokenResponse;
  await db
    .update(workspaces)
    .set({
      hubspotAccessToken: seal(token.access_token),
      hubspotRefreshToken: seal(token.refresh_token),
      hubspotTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
    })
    .where(eq(workspaces.id, workspaceId));
  return token.access_token;
}
