import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Short-lived signed links for attachments. The widget opens a file in a new
// tab, and a plain <a target="_blank"> can't carry the customer's JWT (their
// email must never ride in a URL either). So the customer thread payload hands
// out links carrying an expiry and a 16-byte HMAC-SHA256 of the attachment id
// + expiry under the workspace signing secret (the one behind widget JWTs and
// reply tokens, so rotating it kills outstanding links too). A link opens that
// one attachment until it expires; GET /api/v1/uploads/[id] checks it.

export const ATTACHMENT_LINK_TTL_SECONDS = 60 * 60;

function mac(id: string, exp: number, secret: string): Buffer {
  return createHmac("sha256", secret).update(`attachment:${id}:${exp}`).digest().subarray(0, 16);
}

// Path + query only; the caller prefixes the public origin.
export function signedAttachmentPath(id: string, secret: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + ATTACHMENT_LINK_TTL_SECONDS;
  return `/api/v1/uploads/${id}?exp=${exp}&sig=${mac(id, exp, secret).toString("base64url")}`;
}

export function verifyAttachmentLink(
  id: string,
  exp: string | null,
  sig: string | null,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!exp || !sig || !secret || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= nowMs) return false;
  const expected = mac(id, Number(exp), secret);
  const got = Buffer.from(sig, "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
