import "server-only";
import { createSign, createHmac, timingSafeEqual } from "node:crypto";
import { signState } from "./state";
import { log } from "@/lib/log";

// GitHub App (not OAuth App). Docs:
//   https://docs.github.com/en/apps/creating-github-apps
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
//
// Install flow:
//   1. Admin clicks Connect → we redirect to /apps/{slug}/installations/new?state=<signed>.
//   2. Admin picks org + repos on GitHub.
//   3. GitHub redirects to /api/integrations/github/callback?installation_id=N&setup_action=install&state=...
//      (plus &code=... when the App requests user authorization during install).
//   4. We check the installation belongs to whoever finished the install
//      (verifyInstallOwnership), then persist installation_id + account login.
//      Per-request, we mint a fresh installation token by signing an App JWT
//      and trading it.
//
// Installation tokens expire in 1h; we cache them per installation_id in
// module memory for 50 minutes. Multi-instance Next deploys each mint
// their own; GitHub allows it.

export function githubConfigured(): boolean {
  return !!process.env.GITHUB_APP_ID?.trim()
    && !!process.env.GITHUB_APP_PRIVATE_KEY?.trim()
    && !!process.env.GITHUB_APP_SLUG?.trim();
}

export const GITHUB_APP_ID = () => process.env.GITHUB_APP_ID?.trim() ?? null;
export const GITHUB_APP_SLUG = () => process.env.GITHUB_APP_SLUG?.trim() ?? null;
export const GITHUB_WEBHOOK_SECRET = () => process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? null;
export const GITHUB_REDIRECT_URL = () => process.env.GITHUB_REDIRECT_URL?.trim() ?? null;

// PEM key handling. Env vars typically have \n encoded as literal "\n";
// normalize to real newlines before passing to createSign.
function appPrivateKey(): string {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("GITHUB_APP_PRIVATE_KEY is not configured");
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

// Build the install URL the admin clicks through. State carries the
// workspace_id so the callback knows which workspace the install belongs
// to (GitHub doesn't echo our state for installations the same way OAuth
// flows do — but it does on the App's setup URL).
export function buildAuthUrl(workspaceId: string): string {
  const slug = GITHUB_APP_SLUG();
  if (!slug) throw new Error("GITHUB_APP_SLUG is not configured");
  const params = new URLSearchParams({ state: signState("github", workspaceId) });
  return `https://github.com/apps/${slug}/installations/new?${params.toString()}`;
}

// ─── App JWT + installation token ───────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintAppJWT(): string {
  const appId = GITHUB_APP_ID();
  if (!appId) throw new Error("GITHUB_APP_ID is not configured");
  const now = Math.floor(Date.now() / 1000);
  // iat at -60s to tolerate clock skew on GitHub's side, exp at +10min.
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 10 * 60, iss: appId };
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = createSign("RSA-SHA256").update(signingInput).sign(appPrivateKey());
  return `${signingInput}.${base64url(sig)}`;
}

// Module-level cache of installation tokens. Keyed by installation_id.
type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min — installations are 60 min.

export async function mintInstallationToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const appJwt = mintAppJWT();
  const resp = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${appJwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`github_installation_token_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return data.token;
}

// Used by the callback to fetch the account (org/user) the App was just
// installed into. The /app/installations/{id} endpoint requires the App
// JWT (NOT an installation token).
export type InstallationMeta = {
  account: { login: string; type: "User" | "Organization" };
  repositorySelection: "all" | "selected";
  created_at: string;
  updated_at: string;
};

export async function fetchInstallationMeta(installationId: string): Promise<InstallationMeta> {
  const appJwt = mintAppJWT();
  const resp = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      authorization: `Bearer ${appJwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`github_installation_meta_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as InstallationMeta;
}

// The callback's installation_id is a bare query parameter and the App JWT
// reads every installation of the App, so on its own it proves nothing about
// who finished the install: a workspace admin could replay their own state
// with another company's id. When the App's OAuth credentials are set (and
// "Request user authorization (OAuth) during installation" is on), GitHub
// adds a `code` to the callback; we trade it for a user-to-server token and
// require the installation in that user's GET /user/installations, as
// GitHub's setup-URL docs advise. Without them, only an install or update
// GitHub recorded in the last 10 minutes passes, which narrows a replay to
// that window but cannot rule it out.
const INSTALL_FRESH_MS = 10 * 60 * 1000;
let warnedWeakOwnership = false;

export async function verifyInstallOwnership(
  installationId: string,
  meta: InstallationMeta,
  callback: { code: string | null; setupAction: string | null },
): Promise<boolean> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    // No fallback once configured: dropping `code` must not downgrade the check.
    if (!callback.code) {
      log.warn("github install callback carried no OAuth code; enable \"Request user authorization (OAuth) during installation\" on the App", { scope: "crumb/github" });
      return false;
    }
    try {
      const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: callback.code }),
      });
      const token = (await tokenResp.json()) as { access_token?: string; error?: string };
      if (!token.access_token) {
        log.warn("github user token exchange failed", { scope: "crumb/github", error: token.error ?? tokenResp.status });
        return false;
      }
      // ponytail: first page only; a user who can reach over 100 installations
      // of this App fails closed. Follow the Link header if that ever bites.
      const resp = await fetch("https://api.github.com/user/installations?per_page=100", {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!resp.ok) return false;
      const data = (await resp.json()) as { installations: Array<{ id: number }> };
      return data.installations.some(i => String(i.id) === installationId);
    } catch (err) {
      log.warn("github install ownership check failed", { scope: "crumb/github", err });
      return false;
    }
  }

  if (!warnedWeakOwnership) {
    warnedWeakOwnership = true;
    log.warn("GITHUB_APP_CLIENT_ID/GITHUB_APP_CLIENT_SECRET not set: GitHub install ownership is only checked by install recency (10 min). Set them and enable \"Request user authorization (OAuth) during installation\" on the App.", { scope: "crumb/github" });
  }
  if (callback.setupAction !== "install" && callback.setupAction !== "update") return false;
  const now = Date.now();
  // A missing stamp parses to NaN and fails the comparison.
  return [meta.created_at, meta.updated_at].some(t => Math.abs(now - Date.parse(t)) <= INSTALL_FRESH_MS);
}

// ─── REST API ────────────────────────────────────────────────

async function ghFetch(installationId: string, path: string, init?: RequestInit): Promise<Response> {
  const token = await mintInstallationToken(installationId);
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
}

export type GithubRepo = { fullName: string };

export async function listInstallationRepos(installationId: string): Promise<GithubRepo[]> {
  const resp = await ghFetch(installationId, "/installation/repositories?per_page=100");
  if (!resp.ok) throw new Error(`github_list_repos_failed: ${resp.status}`);
  const data = (await resp.json()) as { repositories: Array<{ full_name: string }> };
  return data.repositories.map(r => ({ fullName: r.full_name }));
}

export type GithubIssueRef = {
  number: number;
  url: string;
  title: string;
  state: string;
};

// The externalTicketId stored for a linked issue. Repo-qualified because a
// bare "#12" exists in every repo; the webhook matches on the same string.
export function issueTicketRef(ownerRepo: string, issueNumber: number): string {
  return `${ownerRepo}#${issueNumber}`;
}

export async function createIssue(
  installationId: string,
  ownerRepo: string,
  input: { title: string; body?: string; labels?: string[] },
): Promise<GithubIssueRef> {
  const resp = await ghFetch(installationId, `/repos/${ownerRepo}/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`github_issue_create_failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { number: number; html_url: string; title: string; state: string };
  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
    state: data.state,
  };
}

export async function listRecentIssues(
  installationId: string,
  ownerRepo: string,
  n: number = 10,
): Promise<Array<{ identifier: string; title: string; stateName: string }>> {
  const resp = await ghFetch(installationId, `/repos/${ownerRepo}/issues?state=all&per_page=${n}&sort=updated`);
  if (!resp.ok) return [];
  const data = (await resp.json()) as Array<{ number: number; title: string; state: string }>;
  return data.map(i => ({
    identifier: `#${i.number}`,
    title: i.title,
    stateName: i.state,
  }));
}

// Repo context for AI ticket drafting. README + top-level tree, capped.
// Fed into drafts for *any* provider when GitHub is connected — code lives
// in GitHub, tickets may live elsewhere.
export type RepoContext = { repo: string; readme: string | null; topLevelTree: string | null };

export async function getRepoContext(installationId: string, ownerRepo: string): Promise<RepoContext> {
  let readme: string | null = null;
  let topLevelTree: string | null = null;

  // README — capped to 4000 chars in lib/ai/ticket.ts; we just fetch raw.
  try {
    const r = await ghFetch(installationId, `/repos/${ownerRepo}/readme`, {
      headers: { accept: "application/vnd.github.raw+json" },
    });
    if (r.ok) {
      const text = await r.text();
      readme = text.length > 8000 ? text.slice(0, 8000) : text;
    }
  } catch { /* non-fatal */ }

  // Top-level tree — `GET /repos/.../contents/` returns the root listing.
  try {
    const r = await ghFetch(installationId, `/repos/${ownerRepo}/contents/`);
    if (r.ok) {
      const data = (await r.json()) as Array<{ name: string; type: string }>;
      topLevelTree = data
        .filter(d => d.type === "dir" || d.type === "file")
        .map(d => d.type === "dir" ? `${d.name}/` : d.name)
        .join(", ");
    }
  } catch { /* non-fatal */ }

  return { repo: ownerRepo, readme, topLevelTree };
}

// Webhook signature — `X-Hub-Signature-256: sha256=<hex>`.
export function verifyWebhook(rawBody: string, signatureHeader: string | null): boolean {
  const secret = GITHUB_WEBHOOK_SECRET();
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
