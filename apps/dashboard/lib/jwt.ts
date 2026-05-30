import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Tiny HS256 implementation. The widget identity JWT is short-lived and
// per-workspace; we keep the surface area minimal and avoid the extra dep.

export type IdentityClaims = {
  /** Workspace slug. Lets us look up the right signing secret. */
  iss: string;
  /** Account-user email — the customer's identity. */
  sub: string;
  /** Optional display name. */
  name?: string;
  /** Customer-side account name (e.g. "Acme Co"). */
  account_name: string;
  /** Optional host-designated account role. When present, the host product is
   *  the source of truth for admin status (re-applied on every widget load). */
  role?: "admin" | "member";
  /** Expiry (seconds since epoch). Required. */
  exp: number;
  /** Issued-at (seconds since epoch). Required to bound clock skew. */
  iat?: number;
};

function b64uEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64uDecode(s: string): Buffer {
  const pad = s.length % 4;
  const padded = pad ? s + "=".repeat(4 - pad) : s;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign256(secret: string, msg: string): Buffer {
  return createHmac("sha256", secret).update(msg).digest();
}

const HEADER = b64uEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export function sign(claims: IdentityClaims, secret: string): string {
  const payload = b64uEncode(JSON.stringify(claims));
  const sig = b64uEncode(sign256(secret, `${HEADER}.${payload}`));
  return `${HEADER}.${payload}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: IdentityClaims }
  | { ok: false; reason: "shape" | "signature" | "expired" | "json" | "iat" | "ttl" };

// A leaked identity token is only as dangerous as it is long-lived. We
// recommend ~1h tokens in the docs; this caps the accepted lifetime so a
// vendor who accidentally mints a multi-year token (or an attacker who
// forges one with a valid secret) still can't ride it forever. Only enforced
// when `iat` is present (the documented minting example always sets it).
const DEFAULT_MAX_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

export function verify(
  token: string,
  secret: string,
  opts: { clockSkewSec?: number; maxTtlSec?: number } = {},
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "shape" };
  const [h, p, s] = parts;
  if (!h || !p || !s) return { ok: false, reason: "shape" };

  const expected = sign256(secret, `${h}.${p}`);
  const got = b64uDecode(s);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: "signature" };
  }

  let claims: IdentityClaims;
  try {
    claims = JSON.parse(b64uDecode(p).toString("utf8")) as IdentityClaims;
  } catch {
    return { ok: false, reason: "json" };
  }

  if (typeof claims.exp !== "number") return { ok: false, reason: "shape" };
  const now = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? 30;
  if (claims.exp + skew < now) return { ok: false, reason: "expired" };

  // Bound the lifetime so a leaked/forged token can't be long-lived.
  const maxTtl = opts.maxTtlSec ?? DEFAULT_MAX_TTL_SEC;
  if (typeof claims.iat === "number") {
    if (claims.iat - skew > now) return { ok: false, reason: "iat" }; // future-dated
    if (claims.exp - claims.iat > maxTtl) return { ok: false, reason: "ttl" };
  } else {
    // No iat to anchor against — bound exp relative to now instead, so a
    // token can't claim a far-future expiry to dodge the cap.
    if (claims.exp - now > maxTtl + skew) return { ok: false, reason: "ttl" };
  }

  // Required shape:
  if (!claims.iss || !claims.sub || !claims.account_name) return { ok: false, reason: "shape" };

  return { ok: true, claims };
}
