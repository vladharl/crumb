import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Inbound reply addresses look like:
//   reply+FB-1.aBcD1234EfGhIjKl@<CRUMB_INBOUND_DOMAIN>
//
// The local part carries two halves separated by '.':
//   - the item's shortId (visible, so the address is debuggable in logs)
//   - a 16-byte HMAC-SHA256 of the shortId under the workspace signing secret
//     (base64url, no padding), proving the address wasn't forged
//
// The same secret already protects widget JWTs (workspaces.signing_secret),
// so a single rotation invalidates both vectors. The shortId is per-workspace
// unique, so collisions across workspaces aren't possible.

const HMAC_LEN = 16;

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

export function signReplyToken(itemShortId: string, signingSecret: string): string {
  return b64url(hmacBytes(signingSecret, itemShortId));
}

export function verifyReplyToken(itemShortId: string, token: string, signingSecret: string): boolean {
  const expected = hmacBytes(signingSecret, itemShortId);
  const got = fromB64url(token);
  if (!got || got.length !== expected.length) return false;
  return timingSafeEqual(expected, got);
}

export function buildReplyAddress(itemShortId: string, signingSecret: string, inboundDomain: string): string {
  const token = signReplyToken(itemShortId, signingSecret);
  return `reply+${itemShortId}.${token}@${inboundDomain}`;
}

// Pull the (shortId, token) pair out of any of the addresses the inbound
// payload might carry — `to`, `delivered-to`, etc. The provider may give us
// either `Name <addr>` or bare `addr`. We preserve the token's original
// case (base64url is case-sensitive) but lowercase the literal "reply+"
// prefix for matching.
export function parseReplyAddress(raw: string): { shortId: string; token: string } | null {
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle ? angle[1]! : raw).trim();

  const at = addr.indexOf("@");
  if (at < 0) return null;
  const local = addr.slice(0, at);

  // Match "reply+" prefix case-insensitively; everything after is preserved.
  if (!/^reply\+/i.test(local)) return null;
  const rest = local.slice(local.indexOf("+") + 1);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const shortId = rest.slice(0, dot).toUpperCase(); // shortIds stored as FB-1 (uppercase)
  const token = rest.slice(dot + 1);
  if (!shortId || !token) return null;
  return { shortId, token };
}
