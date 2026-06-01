import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Per-workspace inbound address for forwarded-email capture:
//   inbox+<slug>.<token>@<CRUMB_INBOUND_DOMAIN>
//
// Unlike the reply address (lib/reply-token.ts), this must let us identify the
// WORKSPACE *from the address itself* — so it can't be signed under the
// per-workspace signing secret (chicken/egg). It's signed under the deployment
// secret CRUMB_INBOUND_SECRET (also the inbound webhook bearer + an OAuth-state
// fallback). The slug is visible (debuggable); the token (16-byte HMAC of the
// slug) proves the address wasn't forged. Fails closed when the secret is unset.

const HMAC_LEN = 16;

export function inboundSecret(): string {
  return process.env.CRUMB_INBOUND_SECRET?.trim() || "";
}

function hmacBytes(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest().subarray(0, HMAC_LEN);
}
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(s: string): Buffer | null {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (s.length % 4)) % 4);
  try { return Buffer.from(padded, "base64"); } catch { return null; }
}

export function signInboxToken(slug: string): string {
  return b64url(hmacBytes(inboundSecret(), slug.toLowerCase()));
}

export function verifyInboxToken(slug: string, token: string): boolean {
  const secret = inboundSecret();
  if (!secret) return false; // fail closed — feature requires the secret
  const expected = hmacBytes(secret, slug.toLowerCase());
  const got = fromB64url(token);
  if (!got || got.length !== expected.length) return false;
  return timingSafeEqual(expected, got);
}

export function buildInboxAddress(slug: string, inboundDomain: string): string {
  return `inbox+${slug.toLowerCase()}.${signInboxToken(slug)}@${inboundDomain}`;
}

// Extract (slug, token) from any of the addresses an inbound payload carries.
// Slugs are [a-z0-9-] (no dots), so splitting the local part on the FIRST dot
// cleanly separates slug from the base64url token (which may contain none).
export function parseInboxAddress(raw: string): { slug: string; token: string } | null {
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle ? angle[1]! : raw).trim();
  const at = addr.indexOf("@");
  if (at < 0) return null;
  const local = addr.slice(0, at);
  if (!/^inbox\+/i.test(local)) return null;
  const rest = local.slice(local.indexOf("+") + 1);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const slug = rest.slice(0, dot).toLowerCase();
  const token = rest.slice(dot + 1);
  if (!slug || !token) return null;
  return { slug, token };
}
