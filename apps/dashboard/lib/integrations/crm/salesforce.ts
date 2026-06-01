import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces, type Workspace } from "@crumb/db";
import { signState } from "../state";
import { seal, open } from "../../crypto-at-rest";
import { clearProviderInstall, IntegrationAuthError } from "../revoke";
import { log } from "@/lib/log";
import type { CrmAdapter, CrmCompany, CrmTokens } from "./types";
import { dollarsToArrCents } from "./types";

// Salesforce OAuth 2.0 web-server flow + REST/SOQL. Docs:
//   https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
// The token response carries the per-org `instance_url` that scopes every
// subsequent REST call. Sandboxes use test.salesforce.com — override the login
// host with SALESFORCE_LOGIN_URL.

const API_VERSION = "v59.0";
const SCOPES = "api refresh_token";

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

  async listCompaniesWithArr(workspace): Promise<CrmCompany[]> {
    const t = await getValidToken(workspace);
    if (!t) return [];
    const soql = encodeURIComponent("SELECT Id, Name, AnnualRevenue FROM Account WHERE Name != null");
    const out: CrmCompany[] = [];
    let nextUrl: string | null = `${t.instanceUrl}/services/data/${API_VERSION}/query?q=${soql}`;
    for (let page = 0; page < 50 && nextUrl; page++) {
      const resp: Response = await fetch(nextUrl, {
        headers: { authorization: `Bearer ${t.accessToken}`, accept: "application/json" },
      });
      if (resp.status === 401) {
        // Token expired/revoked — one reactive refresh, then retry once.
        const refreshed = await refreshToken(workspace);
        if (!refreshed) {
          await clearProviderInstall(workspace.id, "salesforce");
          throw new IntegrationAuthError("salesforce", "401");
        }
        return this.listCompaniesWithArr({ ...workspace, salesforceAccessToken: seal(refreshed.accessToken) });
      }
      if (!resp.ok) {
        log.error("salesforce query failed", { scope: "crumb/salesforce", status: resp.status });
        break;
      }
      const data = (await resp.json()) as {
        records?: Array<{ Id: string; Name: string; AnnualRevenue: number | null }>;
        nextRecordsUrl?: string;
        done?: boolean;
      };
      for (const r of data.records ?? []) {
        if (!r.Name) continue;
        out.push({ externalId: r.Id, name: r.Name, arrCents: dollarsToArrCents(r.AnnualRevenue) });
      }
      nextUrl = data.nextRecordsUrl ? `${t.instanceUrl}${data.nextRecordsUrl}` : null;
    }
    return out;
  },
};

async function getValidToken(workspace: Workspace): Promise<{ accessToken: string; instanceUrl: string } | null> {
  if (!workspace.salesforceAccessToken || !workspace.salesforceInstanceUrl) return null;
  return {
    accessToken: open(workspace.salesforceAccessToken),
    instanceUrl: workspace.salesforceInstanceUrl.replace(/\/+$/, ""),
  };
}

// Reactive refresh (Salesforce tokens have no expiry we can read). Persists the
// new access token. Returns null when there's no refresh token to use.
async function refreshToken(workspace: Workspace): Promise<{ accessToken: string } | null> {
  if (!workspace.salesforceRefreshToken) return null;
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) return null;
  const resp = await fetch(`${loginUrl()}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: id,
      client_secret: secret,
      refresh_token: open(workspace.salesforceRefreshToken),
    }),
  });
  if (!resp.ok) return null;
  const token = (await resp.json()) as TokenResponse;
  await db
    .update(workspaces)
    .set({
      salesforceAccessToken: seal(token.access_token),
      ...(token.instance_url ? { salesforceInstanceUrl: token.instance_url } : {}),
    })
    .where(eq(workspaces.id, workspace.id));
  return { accessToken: token.access_token };
}
