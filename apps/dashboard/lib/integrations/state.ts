import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// HMAC-signed OAuth state, keyed by provider so a leaked state value for
// one provider can't be replayed against another. Used by all integration
// OAuth flows (Slack, Linear, Jira, GitHub).
//
// Format: `{provider}.{workspaceId}.{nonce}.{sig}` where
//   sig = HMAC-SHA256("{provider}.{workspaceId}.{nonce}", stateSecret())
//
// The secret falls back through several env names so self-host doesn't
// need to set a new variable per integration: prefer a dedicated
// CRUMB_OAUTH_STATE_SECRET, fall back to CRUMB_INBOUND_SECRET (already
// in use for the reply webhook). Final fallback is any one of the
// provider client secrets — guarantees a non-empty key in dev when the
// admin has configured at least one OAuth app.

export type Provider = "slack" | "linear" | "jira" | "github" | "hubspot" | "salesforce";

function stateSecret(): string {
  return (
    process.env.CRUMB_OAUTH_STATE_SECRET?.trim() ||
    process.env.CRUMB_INBOUND_SECRET?.trim() ||
    process.env.SLACK_CLIENT_SECRET?.trim() ||
    process.env.LINEAR_CLIENT_SECRET?.trim() ||
    process.env.JIRA_CLIENT_SECRET?.trim() ||
    process.env.GITHUB_APP_PRIVATE_KEY?.trim() ||
    process.env.HUBSPOT_CLIENT_SECRET?.trim() ||
    process.env.SALESFORCE_CLIENT_SECRET?.trim() ||
    ""
  );
}

export function signState(provider: Provider, workspaceId: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `${provider}.${workspaceId}.${nonce}`;
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(
  expectedProvider: Provider,
  state: string,
): { ok: true; workspaceId: string } | { ok: false } {
  const parts = state.split(".");
  if (parts.length !== 4) return { ok: false };
  const [provider, workspaceId, nonce, sig] = parts;
  if (provider !== expectedProvider) return { ok: false };
  const expected = createHmac("sha256", stateSecret())
    .update(`${provider}.${workspaceId}.${nonce}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false };
  if (!timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, workspaceId };
}
