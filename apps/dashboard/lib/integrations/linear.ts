import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { signState } from "./state";
import { IntegrationAuthError } from "./revoke";

// Linear OAuth 2.0. API is GraphQL-only; the auth flow is conventional.
// Docs: https://linear.app/developers/oauth-2-0-authentication
//
// Self-host: vendor registers their own Linear app at linear.app/settings/api
// (Developer → OAuth Applications) and sets LINEAR_CLIENT_ID/SECRET +
// redirect URL to /api/integrations/linear/callback.

const AUTH_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

// `read` lets us list recent issues for AI context + read team metadata.
// `write` lets us create issues. Linear's broad scopes — no granular
// issues:create yet at the OAuth level (the API enforces per-action perms).
const SCOPES = "read,write";

export function linearConfigured(): boolean {
  return !!process.env.LINEAR_CLIENT_ID?.trim() && !!process.env.LINEAR_CLIENT_SECRET?.trim();
}

export const LINEAR_CLIENT_ID = () => process.env.LINEAR_CLIENT_ID?.trim() ?? null;
export const LINEAR_CLIENT_SECRET = () => process.env.LINEAR_CLIENT_SECRET?.trim() ?? null;
export const LINEAR_REDIRECT_URL = () => process.env.LINEAR_REDIRECT_URL?.trim() ?? null;
export const LINEAR_WEBHOOK_SECRET = () => process.env.LINEAR_WEBHOOK_SECRET?.trim() ?? null;

// Verify a Linear webhook against the workspace's configured signing
// secret. Linear sends the signature in the `linear-signature` header as
// a hex SHA-256 HMAC of the raw request body.
export function verifyWebhook(rawBody: string, signature: string | null): boolean {
  const secret = LINEAR_WEBHOOK_SECRET();
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function buildAuthUrl(workspaceId: string, redirectUrl: string): string {
  const clientId = LINEAR_CLIENT_ID();
  if (!clientId) throw new Error("LINEAR_CLIENT_ID is not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUrl,
    response_type: "code",
    scope: SCOPES,
    state: signState("linear", workspaceId),
    // `prompt=consent` forces Linear's grant screen each time, so a user
    // reconnecting against a different workspace sees the picker.
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  // Seconds: 24 hours, since Linear moved every OAuth app to refresh tokens
  // on 2026-04-01.
  // ponytail: no refresh-token support yet. The refresh_token Linear returns
  // isn't stored, so a day after connecting, the calls that use the access
  // token (ticket create, team list, AI context) fail as revoked until an admin
  // reconnects. Storing and using it is a separate follow-up (it needs a
  // column). Status sync never uses the token (see the webhook).
  expires_in: number;
  scope: string;
};

export async function exchangeCode(code: string, redirectUrl: string): Promise<TokenResponse> {
  const clientId = LINEAR_CLIENT_ID();
  const clientSecret = LINEAR_CLIENT_SECRET();
  if (!clientId || !clientSecret) throw new Error("LINEAR creds not configured");

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUrl,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`linear_token_exchange_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResponse;
}

// ─── GraphQL client ──────────────────────────────────────────

async function gql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  // A revoked/invalid OAuth token returns 401 (or an authentication GraphQL
  // error). Signal it distinctly so callers can clear the install.
  if (resp.status === 401) throw new IntegrationAuthError("linear", "401");
  const data = await resp.json();
  if (data.errors) {
    const msg = JSON.stringify(data.errors).slice(0, 300);
    if (/authentication|unauthenticated|unauthorized|invalid.*token/i.test(msg)) {
      throw new IntegrationAuthError("linear", "gql_auth");
    }
    throw new Error(`linear_gql_error: ${msg}`);
  }
  return data.data as T;
}

// Called once at install time, with the fresh token: the Linear org it belongs
// to (the webhook scopes status updates by it) and the user's default team. We
// pick the first team and stash it on the workspace; vendors can change it
// later via the settings card.
export async function fetchInstallInfo(token: string): Promise<{
  organizationId: string;
  team: { id: string; name: string } | null;
}> {
  type R = { organization: { id: string }; teams: { nodes: Array<{ id: string; name: string }> } };
  const data = await gql<R>(token, `query { organization { id } teams(first: 1) { nodes { id name } } }`);
  const team = data.teams.nodes[0];
  return { organizationId: data.organization.id, team: team ? { id: team.id, name: team.name } : null };
}

// ─── tickets ─────────────────────────────────────────────────

export type LinearTeam = { id: string; name: string; key: string };

// Every team the token can see, a page (Linear's maximum, 250) at a time.
// ponytail: stops after 10 pages (2,500 teams).
export async function listTeams(token: string): Promise<LinearTeam[]> {
  type R = { teams: { nodes: LinearTeam[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
  const teams: LinearTeam[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: R = await gql<R>(
      token,
      `query Teams($after: String) { teams(first: 250, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    teams.push(...data.teams.nodes);
    if (!data.teams.pageInfo.hasNextPage || !data.teams.pageInfo.endCursor) break;
    after = data.teams.pageInfo.endCursor;
  }
  return teams;
}

export type LinearIssueRef = {
  id: string;
  identifier: string;  // e.g. "ENG-123"
  url: string;
  title: string;
  stateName: string;   // e.g. "Backlog"
};

// Create a new issue in the given team. We pass title + description
// straight through; labels/assignee are optional refinements we don't
// surface in the v1 modal but keep here for the AI suggestion path.
export async function createIssue(
  token: string,
  input: { teamId: string; title: string; description?: string; labelIds?: string[] },
): Promise<LinearIssueRef> {
  type R = {
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; url: string; title: string; state: { name: string } | null };
    };
  };
  const data = await gql<R>(
    token,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title state { name } }
      }
    }`,
    { input },
  );
  if (!data.issueCreate.success) throw new Error("linear_issue_create_failed");
  const i = data.issueCreate.issue;
  return {
    id: i.id,
    identifier: i.identifier,
    url: i.url,
    title: i.title,
    stateName: i.state?.name ?? "Backlog",
  };
}

// Fetch an issue by node id — used by the webhook handler to confirm
// state changes and refresh status.
export async function fetchIssue(token: string, issueId: string): Promise<LinearIssueRef | null> {
  type R = {
    issue: { id: string; identifier: string; url: string; title: string; state: { name: string } | null } | null;
  };
  const data = await gql<R>(
    token,
    `query Issue($id: String!) { issue(id: $id) { id identifier url title state { name } } }`,
    { id: issueId },
  );
  if (!data.issue) return null;
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    url: data.issue.url,
    title: data.issue.title,
    stateName: data.issue.state?.name ?? "Backlog",
  };
}

// Recent issues from a team, for AI prompt context. Title-only on
// purpose — the model gets the team's voice from titles without us
// paying for thousands of tokens of body text.
export async function listRecentIssues(
  token: string,
  teamId: string,
  n: number = 10,
): Promise<Array<{ identifier: string; title: string; stateName: string }>> {
  type R = {
    team: {
      issues: {
        nodes: Array<{ identifier: string; title: string; state: { name: string } | null }>;
      };
    } | null;
  };
  const data = await gql<R>(
    token,
    `query RecentIssues($teamId: String!, $n: Int!) {
      team(id: $teamId) {
        issues(first: $n, orderBy: updatedAt) {
          nodes { identifier title state { name } }
        }
      }
    }`,
    { teamId, n },
  );
  return (data.team?.issues.nodes ?? []).map(i => ({
    identifier: i.identifier,
    title: i.title,
    stateName: i.state?.name ?? "—",
  }));
}
