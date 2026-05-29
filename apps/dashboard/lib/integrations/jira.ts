import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { signState, verifyState } from "./state";

// Atlassian Cloud OAuth 2.0 (3LO).
// Docs: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
//
// Two key Jira-specific gotchas:
//  1. cloud_id discovery via /accessible-resources is a SEPARATE step
//     after token exchange. We re-call it on every token refresh so a
//     user reinstalling against a different site doesn't silently 404
//     against the cached cloud_id. (See plan: "Highest risks", #1.)
//  2. Refresh tokens rotate. On refresh, store the NEW refresh_token
//     alongside the new access_token.

const AUTH_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

// Minimum scopes for "list + create issues + read project metadata".
// offline_access gets us the refresh token.
const SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
].join(" ");

export function jiraConfigured(): boolean {
  return !!process.env.JIRA_CLIENT_ID?.trim() && !!process.env.JIRA_CLIENT_SECRET?.trim();
}

export const JIRA_CLIENT_ID = () => process.env.JIRA_CLIENT_ID?.trim() ?? null;
export const JIRA_CLIENT_SECRET = () => process.env.JIRA_CLIENT_SECRET?.trim() ?? null;
export const JIRA_REDIRECT_URL = () => process.env.JIRA_REDIRECT_URL?.trim() ?? null;
export const JIRA_WEBHOOK_SECRET = () => process.env.JIRA_WEBHOOK_SECRET?.trim() ?? null;

export function buildAuthUrl(workspaceId: string, redirectUrl: string): string {
  const clientId = JIRA_CLIENT_ID();
  if (!clientId) throw new Error("JIRA_CLIENT_ID is not configured");
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUrl,
    state: signState("jira", workspaceId),
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function verifyJiraState(state: string): { ok: true; workspaceId: string } | { ok: false } {
  return verifyState("jira", state);
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  scope: string;
  token_type: "Bearer";
};

export async function exchangeCode(code: string, redirectUrl: string): Promise<TokenResponse> {
  const clientId = JIRA_CLIENT_ID();
  const clientSecret = JIRA_CLIENT_SECRET();
  if (!clientId || !clientSecret) throw new Error("JIRA creds not configured");

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUrl,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`jira_token_exchange_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResponse;
}

// Atlassian's per-tenant cloud_id discovery. Called at install and on
// every refresh — the user may reinstall against a different site keeping
// the same refresh_token, in which case the cached cloud_id silently 404s.
export type AccessibleResource = {
  id: string;        // cloud_id
  url: string;       // e.g. "https://acme.atlassian.net"
  name: string;
  scopes: string[];
};

export async function fetchAccessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  const resp = await fetch(RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`jira_resources_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as AccessibleResource[];
}

// Refresh path. ALWAYS re-discovers accessible resources and updates the
// cached cloud_id on the workspace if it changed. Returns the fresh access
// token so the caller can immediately use it.
export async function refreshToken(workspaceId: string, currentRefreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  cloudId: string;
  siteUrl: string;
}> {
  const clientId = JIRA_CLIENT_ID();
  const clientSecret = JIRA_CLIENT_SECRET();
  if (!clientId || !clientSecret) throw new Error("JIRA creds not configured");

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: currentRefreshToken,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`jira_refresh_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const token = (await resp.json()) as TokenResponse;
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);

  // Re-discover. Pick the first resource; vendors with multiple sites
  // would pick a default at install time (out of scope for v1).
  const resources = await fetchAccessibleResources(token.access_token);
  const target = resources[0];
  if (!target) throw new Error("jira_no_accessible_resources");

  await db
    .update(workspaces)
    .set({
      jiraAccessToken:    token.access_token,
      jiraRefreshToken:   token.refresh_token,
      jiraTokenExpiresAt: expiresAt,
      jiraCloudId:        target.id,
      jiraSiteUrl:        target.url,
    })
    .where(eq(workspaces.id, workspaceId));

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    cloudId: target.id,
    siteUrl: target.url,
  };
}

// Get a valid access token for an outbound API call. Refreshes proactively
// if the cached token is within 60s of expiry.
async function getValidToken(workspace: {
  id: string;
  jiraAccessToken: string | null;
  jiraRefreshToken: string | null;
  jiraTokenExpiresAt: Date | null;
}): Promise<{ accessToken: string; cloudId: string } | null> {
  if (!workspace.jiraAccessToken || !workspace.jiraRefreshToken) return null;
  const expSoon = !workspace.jiraTokenExpiresAt
    || workspace.jiraTokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expSoon) {
    // Use the cached token; pair it with the cached cloud_id (loaded by caller).
    const [row] = await db
      .select({ jiraCloudId: workspaces.jiraCloudId })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
      .limit(1);
    if (!row?.jiraCloudId) return null;
    return { accessToken: workspace.jiraAccessToken, cloudId: row.jiraCloudId };
  }
  const refreshed = await refreshToken(workspace.id, workspace.jiraRefreshToken);
  return { accessToken: refreshed.accessToken, cloudId: refreshed.cloudId };
}

// ─── REST API helpers ───────────────────────────────────────

function apiBase(cloudId: string): string {
  return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
}

export type JiraProject = { id: string; key: string; name: string };

export async function listProjects(workspace: Parameters<typeof getValidToken>[0]): Promise<JiraProject[]> {
  const t = await getValidToken(workspace);
  if (!t) return [];
  const resp = await fetch(`${apiBase(t.cloudId)}/project/search?maxResults=50&orderBy=name`, {
    headers: { authorization: `Bearer ${t.accessToken}`, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`jira_list_projects_failed: ${resp.status}`);
  const data = (await resp.json()) as { values: Array<{ id: string; key: string; name: string }> };
  return data.values.map(p => ({ id: p.id, key: p.key, name: p.name }));
}

export type JiraIssueRef = {
  id: string;
  key: string;             // "PROJ-123"
  url: string;
  title: string;
  statusName: string;
};

// Description in v3 must be ADF (Atlassian Document Format), not plain
// markdown. We wrap the markdown-ish body into a minimal ADF doc — a
// single paragraph per line. Fine for v1; a richer markdown→ADF mapping
// is a follow-up if vendors complain.
function bodyToAdf(body: string): unknown {
  const lines = body.split(/\r?\n/);
  return {
    type: "doc",
    version: 1,
    content: lines.map(line => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

export async function createIssue(
  workspace: Parameters<typeof getValidToken>[0] & { jiraSiteUrl: string | null },
  input: { projectKey: string; title: string; description?: string; issueType?: string },
): Promise<JiraIssueRef> {
  const t = await getValidToken(workspace);
  if (!t) throw new Error("jira_not_authenticated");
  const resp = await fetch(`${apiBase(t.cloudId)}/issue`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${t.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: input.projectKey },
        summary: input.title,
        description: input.description ? bodyToAdf(input.description) : undefined,
        issuetype: { name: input.issueType ?? "Task" },
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`jira_issue_create_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const created = (await resp.json()) as { id: string; key: string; self: string };
  const url = workspace.jiraSiteUrl ? `${workspace.jiraSiteUrl}/browse/${created.key}` : created.self;
  return {
    id: created.id,
    key: created.key,
    url,
    title: input.title,
    statusName: "To Do",
  };
}

export async function listRecentIssues(
  workspace: Parameters<typeof getValidToken>[0],
  projectKey: string,
  n: number = 10,
): Promise<Array<{ identifier: string; title: string; stateName: string }>> {
  const t = await getValidToken(workspace);
  if (!t) return [];
  const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
  const resp = await fetch(`${apiBase(t.cloudId)}/search?jql=${jql}&maxResults=${n}&fields=summary,status`, {
    headers: { authorization: `Bearer ${t.accessToken}`, accept: "application/json" },
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    issues: Array<{ key: string; fields: { summary: string; status: { name: string } } }>;
  };
  return data.issues.map(i => ({
    identifier: i.key,
    title: i.fields.summary,
    stateName: i.fields.status?.name ?? "—",
  }));
}

// Webhook signature. Atlassian sends `X-Hub-Signature` with format
// `sha256=<hex>` when the webhook is configured with a secret.
export function verifyWebhook(rawBody: string, signatureHeader: string | null): boolean {
  const secret = JIRA_WEBHOOK_SECRET();
  if (!secret || !signatureHeader) return false;
  const m = signatureHeader.match(/^sha256=([0-9a-f]+)$/i);
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(m[1], "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
