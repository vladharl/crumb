import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { signState } from "../state";
import { seal, open } from "../../crypto-at-rest";
import { clearProviderInstall, IntegrationAuthError } from "../revoke";
import type { CrmAdapter, CrmField, CrmTokens } from "./types";
import { dollarsToArrCents, fetchWithRetry, safeFieldName } from "./types";

// Salesforce OAuth 2.0 web-server flow + REST/SOQL. Docs:
//   https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
// The token response carries the per-org `instance_url` that scopes every
// subsequent REST call. Sandboxes use test.salesforce.com — override the login
// host with SALESFORCE_LOGIN_URL.

const API_VERSION = "v59.0";
const SCOPES = "api refresh_token";
// Account field types the ARR picker offers.
const NUMBER_TYPES = new Set(["currency", "double", "int", "long"]);

function loginUrl() {
  return (process.env.SALESFORCE_LOGIN_URL?.trim() || "https://login.salesforce.com").replace(/\/+$/, "");
}
function clientId() { return process.env.SALESFORCE_CLIENT_ID?.trim() || null; }
function clientSecret() { return process.env.SALESFORCE_CLIENT_SECRET?.trim() || null; }

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  issued_at?: string;
};

export const salesforce: CrmAdapter = {
  provider: "salesforce",

  configured() {
    return !!clientId() && !!clientSecret();
  },

  redirectOverride() {
    return process.env.SALESFORCE_REDIRECT_URL?.trim() || null;
  },

  buildAuthUrl(workspaceId, redirectUrl) {
    const id = clientId();
    if (!id) throw new Error("SALESFORCE_CLIENT_ID is not configured");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: id,
      redirect_uri: redirectUrl,
      scope: SCOPES,
      state: signState("salesforce", workspaceId),
    });
    return `${loginUrl()}/services/oauth2/authorize?${params.toString()}`;
  },

  async exchangeCode(code, redirectUrl): Promise<CrmTokens> {
    const id = clientId();
    const secret = clientSecret();
    if (!id || !secret) throw new Error("SALESFORCE creds not configured");
    const resp = await fetch(`${loginUrl()}/services/oauth2/token`, {
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
      throw new Error(`salesforce_token_exchange_failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const token = (await resp.json()) as TokenResponse;
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      // Salesforce access tokens don't carry expires_in; we refresh reactively
      // on a 401 instead of proactively. Leave expiresAt null.
      expiresAt: null,
      instanceUrl: token.instance_url,
    };
  },

  // The admin's pick. AnnualRevenue is the account's own revenue, so there is
  // no default.
  arrField(workspace) {
    return safeFieldName(workspace.salesforceArrField);
  },

  // Number and currency fields on Account, from its describe.
  async numberFields(workspace) {
    if (!workspace.salesforceAccessToken || !workspace.salesforceInstanceUrl) return [];
    const url = `${workspace.salesforceInstanceUrl.replace(/\/+$/, "")}/services/data/${API_VERSION}/sobjects/Account/describe`;
    let accessToken = open(workspace.salesforceAccessToken);
    const get = () => fetchWithRetry(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    let resp = await get();
    if (resp.status === 401) {
      ({ accessToken } = await refreshAccessToken(workspace.id, workspace.salesforceRefreshToken));
      resp = await get();
    }
    if (!resp.ok) throw new Error(`salesforce_describe_failed: ${resp.status}`);
    const data = (await resp.json()) as { fields?: Array<{ name: string; label?: string; type?: string }> };
    return (data.fields ?? [])
      .filter((f) => NUMBER_TYPES.has(f.type ?? "") && safeFieldName(f.name))
      .map((f): CrmField => ({ name: f.name, label: f.label || f.name }));
  },

  // Pages through every Account (no page cap). An expired session refreshes
  // once and retries the same page.
  async *companyPages(workspace, arrField) {
    if (!workspace.salesforceAccessToken || !workspace.salesforceInstanceUrl) return;
    const instanceUrl = workspace.salesforceInstanceUrl.replace(/\/+$/, "");
    let accessToken = open(workspace.salesforceAccessToken);
    let refreshToken = workspace.salesforceRefreshToken;
    const soql = `SELECT Id, Name${arrField ? `, ${arrField}` : ""} FROM Account WHERE Name != null`;
    let nextUrl: string | null = `${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    while (nextUrl) {
      const get = (url: string) =>
        fetchWithRetry(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
      let resp = await get(nextUrl);
      if (resp.status === 401) {
        ({ accessToken, refreshToken } = await refreshAccessToken(workspace.id, refreshToken));
        resp = await get(nextUrl);
      }
      if (!resp.ok) throw new Error(`salesforce_query_failed: ${resp.status}`);
      const data = (await resp.json()) as {
        records?: Array<Record<string, unknown> & { Id: string; Name: string | null }>;
        nextRecordsUrl?: string;
      };
      yield (data.records ?? [])
        .filter((r) => r.Name?.trim())
        .map((r) => ({
          externalId: r.Id,
          name: r.Name!.trim(),
          arrCents: arrField ? dollarsToArrCents(r[arrField]) : null,
        }));
      nextUrl = data.nextRecordsUrl ? `${instanceUrl}${data.nextRecordsUrl}` : null;
    }
  },
};

// Reactive refresh (Salesforce tokens have no expiry we can read). Persists the
// new access token, and the refresh token too when the org rotates them (the
// caller carries the rotated one into its next refresh).
// Disconnects only on invalid_grant (the refresh token was revoked or expired)
// or when there is no refresh token to try. An outage or rate limit is retried
// once; any other failure fails this sync and the next one tries again.
async function refreshAccessToken(
  workspaceId: string,
  sealedRefreshToken: string | null,
): Promise<{ accessToken: string; refreshToken: string }> {
  if (!sealedRefreshToken) {
    await clearProviderInstall(workspaceId, "salesforce");
    throw new IntegrationAuthError("salesforce", "no_refresh_token");
  }
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) throw new Error("SALESFORCE creds not configured");
  const resp = await fetchWithRetry(`${loginUrl()}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: id,
      client_secret: secret,
      refresh_token: open(sealedRefreshToken),
    }),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "invalid_grant") {
      await clearProviderInstall(workspaceId, "salesforce");
      throw new IntegrationAuthError("salesforce", "invalid_grant");
    }
    throw new Error(`salesforce_refresh_failed: ${resp.status} ${body?.error ?? ""}`.trim());
  }
  const token = (await resp.json()) as TokenResponse;
  const rotated = token.refresh_token ? seal(token.refresh_token) : null;
  await db
    .update(workspaces)
    .set({
      salesforceAccessToken: seal(token.access_token),
      ...(rotated ? { salesforceRefreshToken: rotated } : {}),
      ...(token.instance_url ? { salesforceInstanceUrl: token.instance_url } : {}),
    })
    .where(eq(workspaces.id, workspaceId));
  return { accessToken: token.access_token, refreshToken: rotated ?? sealedRefreshToken };
}
