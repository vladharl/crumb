import "server-only";

// In-memory sliding-window-ish rate limiter, keyed on caller fingerprint
// (e.g. IP + endpoint). Process-local — fine for single-VM self-host;
// Cloud multi-instance gets swapped to a Redis-backed implementation in
// a follow-up turn (same exported signature).
//
// The algorithm is a token bucket: each key has a fixed capacity, refilled
// at a per-second rate. Calls that find a non-empty bucket are allowed and
// decrement the count; empty buckets respond with the time-until-next-token.

type Bucket = { tokens: number; lastRefill: number };

const buckets = new Map<string, Bucket>();
// Defaults: 60 requests / minute. Override per call site if a path needs
// a tighter limit (e.g. uploads can be slower than submits).
const DEFAULT_CAPACITY = parseInt(process.env.CRUMB_RATE_LIMIT_CAPACITY ?? "60", 10);
const DEFAULT_REFILL_PER_SEC = parseFloat(process.env.CRUMB_RATE_LIMIT_REFILL_PER_SEC ?? "1");

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number };

export function checkRateLimit(
  key: string,
  opts: { capacity?: number; refillPerSec?: number } = {},
): RateLimitResult {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const refill = opts.refillPerSec ?? DEFAULT_REFILL_PER_SEC;
  const now = Date.now();

  const existing = buckets.get(key);
  if (!existing) {
    buckets.set(key, { tokens: capacity - 1, lastRefill: now });
    return { ok: true, remaining: capacity - 1 };
  }
  // Refill based on elapsed time.
  const elapsedSec = (now - existing.lastRefill) / 1000;
  const refilled = Math.min(capacity, existing.tokens + elapsedSec * refill);
  if (refilled >= 1) {
    existing.tokens = refilled - 1;
    existing.lastRefill = now;
    return { ok: true, remaining: Math.floor(existing.tokens) };
  }
  // No tokens — caller must wait this long for the next one.
  const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) / refill));
  // Keep lastRefill stable so the next call can still credit elapsed time.
  return { ok: false, retryAfterSeconds };
}

// Best-effort caller fingerprint from headers a proxy is likely to set.
// Falls back to "anon" so the limiter still applies (whole population
// shares the bucket — fine for tiny self-host instances).
export function callerIpFromRequest(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "anon";
}

// Helper that produces the standard 429 NextResponse shape used by the
// public API. Centralizes the Retry-After header.
import { NextResponse } from "next/server";
import { CORS_HEADERS } from "./public-api";
export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  const res = NextResponse.json(
    { error: "rate_limited", retry_after_seconds: retryAfterSeconds },
    { status: 429 },
  );
  res.headers.set("Retry-After", String(retryAfterSeconds));
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}
