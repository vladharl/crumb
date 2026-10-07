import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mint the credentials real clients carry, so specs drive the true auth paths
// instead of mocking around them. Each signer mirrors its lib/ original; keep
// them in step:
//   mintWidgetJwt      lib/jwt.ts sign (verified by lib/public-api.ts)
//   mintMagicLink      lib/auth.ts issueMagicLink
//   signReplyAddress   lib/reply-token.ts buildReplyAddress
//   signAttachmentPath lib/attachments/signed-url.ts signedAttachmentPath

// SQL against the e2e Postgres (docker container crumb-postgres, as setup.ts).
// Sent over stdin, so no shell quoting; still, interpolate trusted test values
// only. Returns the rows unaligned (`a|b`, one per line); throws on any error.
export function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", "crumb-postgres", "psql", "-qtA", "-v", "ON_ERROR_STOP=1", "-U", "crumb", "-d", "crumb"],
    { input: sql, encoding: "utf8" },
  ).trim();
}

export function workspaceSigningSecret(slug: string): string {
  const secret = psql(`SELECT signing_secret FROM workspaces WHERE slug = '${slug}'`);
  if (!secret) throw new Error(`no workspace "${slug}"`);
  return secret;
}

function hmac(secret: string, msg: string): Buffer {
  return createHmac("sha256", secret).update(msg).digest();
}

function b64u(json: unknown): string {
  return Buffer.from(JSON.stringify(json)).toString("base64url");
}

export type WidgetClaims = {
  sub: string; // the customer's email
  account_name: string;
  name?: string;
  role?: "admin" | "member";
  iat?: number;
  exp?: number;
};

// A widget identity JWT for `Authorization: Bearer`: HS256 under the workspace
// signing secret, iss = slug, valid for an hour unless the claims say otherwise.
export function mintWidgetJwt(slug: string, claims: WidgetClaims): string {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ iss: slug, iat, exp: iat + 3600, ...claims })}`;
  return `${body}.${hmac(workspaceSigningSecret(slug), body).toString("base64url")}`;
}

// A sign-in path for a dashboard user, minted like issueMagicLink: a 20-minute
// token on the first workspace_users row with that email.
export function mintMagicLink(email: string): string {
  const token = randomBytes(24).toString("base64url");
  const id = psql(
    `INSERT INTO magic_tokens (workspace_id, workspace_user_id, token, expires_at)
     SELECT workspace_id, id, '${token}', now() + interval '20 minutes'
     FROM workspace_users WHERE email = lower('${email}') LIMIT 1
     RETURNING id`,
  );
  if (!id) throw new Error(`no workspace user "${email}"`);
  return `/login/verify?token=${token}`;
}

// The reply-to address on the workspace's notification emails for an item. The
// domain is the e2e CRUMB_INBOUND_DOMAIN; the inbound route ignores it anyway.
export function signReplyAddress(slug: string, shortId: string, domain = "crumb.test"): string {
  const token = hmac(workspaceSigningSecret(slug), shortId).subarray(0, 16).toString("base64url");
  return `reply+${shortId}.${token}@${domain}`;
}

// A signed attachment link (path + query) expiring at `exp`, unix seconds. The
// customer thread payload hands these out with exp = now + 1h.
export function signAttachmentPath(slug: string, id: string, exp: number): string {
  const sig = hmac(workspaceSigningSecret(slug), `attachment:${id}:${exp}`).subarray(0, 16).toString("base64url");
  return `/api/v1/uploads/${id}?exp=${exp}&sig=${sig}`;
}

// The origin the app puts on its redirects and links (lib/origin.ts):
// CRUMB_APP_URL when the server has one, else the request's own origin.
// ponytail: reads the server's value the way `next dev` loads it, process env
// then .env.local only; add .env.development(.local) / .env if those appear.
export function publicOrigin(requestOrigin: string): string {
  let dotenv: string | undefined;
  try {
    dotenv = readFileSync(resolve(__dirname, "../../../.env.local"), "utf8").match(/^CRUMB_APP_URL=["']?([^"'\s]+)/m)?.[1];
  } catch {
    // no .env.local (CI)
  }
  return (process.env.CRUMB_APP_URL?.trim() || dotenv || requestOrigin).replace(/\/+$/, "");
}
