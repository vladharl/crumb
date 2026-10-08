import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// HMAC-signed OAuth state, keyed by provider so a leaked state value for
// one provider can't be replayed against another. Used by all integration
// OAuth flows (Slack, Linear, Jira, GitHub, HubSpot, Salesforce).
//
// Format: `{provider}.{workspaceId}.{issuedAt}.{nonce}[.{data}].{sig}` where
//   issuedAt = Date.now() when the Connect action built the consent link
//   data = an optional value the flow carries through the provider (GitHub's
//          user authorization carries the installation id), dot-free
//   sig = HMAC-SHA256(everything before it, stateSecret())
//
// A state expires STATE_TTL_MS after issue, so a consent link can't be banked
// and replayed later. It is not single-use (the nonce isn't stored): the
// callbacks also require the signed-in admin of the state's workspace
// (lib/integrations/callback.ts), which is what stops a forwarded link.
//
// The secret falls back through several env names so self-host doesn't
// need to set a new variable per integration: prefer a dedicated
// CRUMB_OAUTH_STATE_SECRET, fall back to CRUMB_INBOUND_SECRET (already
// in use for the reply webhook). Final fallback is any one of the
// provider client secrets — guarantees a non-empty key in dev when the
// admin has configured at least one OAuth app.

export type Provider = "slack" | "linear" | "jira" | "github" | "hubspot" | "salesforce";

const STATE_TTL_MS = 10 * 60 * 1000;

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

export function signState(provider: Provider, workspaceId: string, data?: string): string {
  if (data !== undefined && !/^[\w-]+$/.test(data)) throw new Error("state data must be dot-free");
  const nonce = randomBytes(16).toString("base64url");
  const body = [provider, workspaceId, Date.now(), nonce, ...(data === undefined ? [] : [data])].join(".");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(
  expectedProvider: Provider,
  state: string,
): { ok: true; workspaceId: string; data?: string } | { ok: false } {
  const parts = state.split(".");
  if (parts.length !== 5 && parts.length !== 6) return { ok: false };
  const sig = parts.pop()!;
  const [provider, workspaceId, issuedAt, , data] = parts;
  if (provider !== expectedProvider) return { ok: false };
  const expected = createHmac("sha256", stateSecret())
    .update(parts.join("."))
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false };
  if (!timingSafeEqual(a, b)) return { ok: false };
  // The stamp is signed, so only its age is in question. abs() also rejects a
  // non-numeric stamp (NaN) and one from a clock running far ahead.
  if (!(Math.abs(Date.now() - Number(issuedAt)) <= STATE_TTL_MS)) return { ok: false };
  return data === undefined ? { ok: true, workspaceId } : { ok: true, workspaceId, data };
}
