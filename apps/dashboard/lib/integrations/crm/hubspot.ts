import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces, type Workspace } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { signState } from "../state";
import { seal, open } from "../../crypto-at-rest";
import { clearProviderInstall, IntegrationAuthError } from "../revoke";
import type { CrmAdapter, CrmCompany, CrmField, CrmTokens } from "./types";
import { dollarsToArrCents, fetchWithRetry, safeFieldName } from "./types";

// HubSpot OAuth 2.0 + CRM v3. Docs:
//   https://developers.hubspot.com/docs/api/oauth-quickstart-guide
//   https://developers.hubspot.com/docs/api/crm/companies
// Read-only: scope crm.objects.companies.read. Tokens are short-lived (~30m)
// with a long-lived refresh token, so we refresh proactively like Jira.

const AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const API_BASE = "https://api.hubapi.com";
const SCOPES = "crm.objects.companies.read oauth";

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

  // The admin's pick. On self-host HUBSPOT_ARR_PROPERTY is the default until
  // one is made; on Cloud an operator-wide property means nothing per tenant.
  arrField(workspace) {
    return safeFieldName(workspace.hubspotArrField)
      ?? (isCloud() ? null : safeFieldName(process.env.HUBSPOT_ARR_PROPERTY));
  },

  // Number properties on companies (currency ones are numbers too).
  async numberFields(workspace) {
    let token = await getValidToken(workspace);
    if (!token) return [];
    const url = `${API_BASE}/crm/v3/properties/companies`;
    let resp = await fetchWithRetry(url, { headers: { authorization: `Bearer ${token}` } });
    if (resp.status === 401 && workspace.hubspotRefreshToken) {
      token = await refreshToken(workspace.id, open(workspace.hubspotRefreshToken));
      resp = await fetchWithRetry(url, { headers: { authorization: `Bearer ${token}` } });
    }
    if (!resp.ok) throw new Error(`hubspot_list_properties_failed: ${resp.status}`);
    const data = (await resp.json()) as { results?: Array<{ name: string; label?: string; type?: string; hidden?: boolean }> };
    return (data.results ?? [])
      .filter((p) => p.type === "number" && !p.hidden && safeFieldName(p.name))
      .map((p): CrmField => ({ name: p.name, label: p.label || p.name }));
  },

  // Pages through the whole portal (no page cap). An access token lasts ~30m
  // and a big portal can outlast one, so a 401 refreshes and retries the page.
  async *companyPages(workspace, arrField) {
    let token = await getValidToken(workspace);
    if (!token) return;
    let after: string | undefined;
    do {
      const url = new URL(`${API_BASE}/crm/v3/objects/companies`);
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", arrField ? `name,${arrField}` : "name");
      if (after) url.searchParams.set("after", after);
      let resp = await fetchWithRetry(url, { headers: { authorization: `Bearer ${token}` } });
      if (resp.status === 401 && workspace.hubspotRefreshToken) {
        token = await refreshToken(workspace.id, open(workspace.hubspotRefreshToken));
        resp = await fetchWithRetry(url, { headers: { authorization: `Bearer ${token}` } });
      }
      if (!resp.ok) throw new Error(`hubspot_list_companies_failed: ${resp.status}`);
      const data = (await resp.json()) as {
        results?: Array<{ id: string; properties?: Record<string, string | null> }>;
        paging?: { next?: { after?: string } };
      };
      const page: CrmCompany[] = [];
      for (const c of data.results ?? []) {
        const name = c.properties?.name?.trim();
        if (!name) continue;
        page.push({ externalId: c.id, name, arrCents: arrField ? dollarsToArrCents(c.properties?.[arrField]) : null });
      }
      yield page;
      after = data.paging?.next?.after;
    } while (after);
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

// Disconnects only when HubSpot rejects the refresh token itself (the app was
// uninstalled or access revoked). An outage, a rate limit or a misconfigured
// client secret fails this sync and the next one tries again.
async function refreshToken(workspaceId: string, currentRefreshToken: string): Promise<string> {
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) throw new Error("HUBSPOT creds not configured");
  const resp = await fetchWithRetry(TOKEN_URL, {
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
    const body = (await resp.json().catch(() => null)) as { status?: string; error?: string } | null;
    if (body?.status === "BAD_REFRESH_TOKEN" || body?.error === "invalid_grant") {
      await clearProviderInstall(workspaceId, "hubspot");
      throw new IntegrationAuthError("hubspot", "refresh_rejected");
    }
    throw new Error(`hubspot_refresh_failed: ${resp.status} ${body?.status ?? ""}`.trim());
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
