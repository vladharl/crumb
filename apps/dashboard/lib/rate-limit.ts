import "server-only";

// Token-bucket rate limiter, keyed on caller fingerprint (e.g. IP +
// endpoint). Each key has a fixed capacity, refilled at a per-second rate.
//
// Two backends behind one async entry point (`checkRateLimitAsync`):
//   • In-memory (default): process-local Map. Correct for single-VM
//     self-host. Exposed synchronously as `checkRateLimit` (also the unit-
//     tested surface and the fallback when Redis is down).
//   • Redis (when CRUMB_REDIS_URL is set): an atomic Lua token bucket shared
//     across instances — required for multi-instance Cloud, where each box
//     keeping its own Map would multiply the effective limit by the box
//     count. ioredis is an optional dependency, loaded only when configured.
//
// Fail-open: if Redis errors or is unreachable, we fall back to the in-memory
// bucket rather than 500 the request — a limiter outage must not take down
// the API. The local bucket still bounds a single instance in the meantime.

// fullAt: when the bucket will have refilled to capacity. From then on it is
// indistinguishable from a fresh one, so the sweep in checkRateLimit drops it
// without changing any answer; the Map stays bounded by recently active keys.
type Bucket = { tokens: number; lastRefill: number; fullAt: number };

const buckets = new Map<string, Bucket>();
// ponytail: a full scan every SWEEP_EVERY calls. A unique-key flood stays
// bounded too (a fresh bucket idles after 1/refill s); add a size cap if not.
const SWEEP_EVERY = 1000;
let callsSinceSweep = 0;
// Defaults: 60 requests / minute. Override per call site if a path needs
// a tighter limit (e.g. uploads can be slower than submits).
const DEFAULT_CAPACITY = parseInt(process.env.CRUMB_RATE_LIMIT_CAPACITY?.trim() || "60", 10);
const DEFAULT_REFILL_PER_SEC = parseFloat(process.env.CRUMB_RATE_LIMIT_REFILL_PER_SEC?.trim() || "1");

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

  if (++callsSinceSweep >= SWEEP_EVERY) {
    callsSinceSweep = 0;
    for (const [k, b] of buckets) if (b.fullAt <= now) buckets.delete(k);
  }

  const existing = buckets.get(key);
  if (!existing) {
    buckets.set(key, { tokens: capacity - 1, lastRefill: now, fullAt: now + 1000 / refill });
    return { ok: true, remaining: capacity - 1 };
  }
  // Refill based on elapsed time.
  const elapsedSec = (now - existing.lastRefill) / 1000;
  const refilled = Math.min(capacity, existing.tokens + elapsedSec * refill);
  if (refilled >= 1) {
    existing.tokens = refilled - 1;
    existing.lastRefill = now;
    existing.fullAt = now + ((capacity - existing.tokens) / refill) * 1000;
    return { ok: true, remaining: Math.floor(existing.tokens) };
  }
  // No tokens — caller must wait this long for the next one.
  const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) / refill));
  // Keep lastRefill stable so the next call can still credit elapsed time.
  return { ok: false, retryAfterSeconds };
}

// ─── Redis backend (multi-instance Cloud) ───────────────────────────────

// Atomic token bucket. Stores {tokens, ts} in a hash; computes refill from
// elapsed time; decrements on allow. Mirrors the in-memory semantics. Returns
// [allowed(0|1), remainingTokens, retryAfterSeconds]. The key self-expires
// once it would fully refill, so idle keys don't accumulate.
const BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = (now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / refill)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / refill) + 10)
return {allowed, math.floor(tokens), retry}
`;

type RedisLike = {
  eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

let redisClient: Promise<RedisLike | null> | null | undefined;

function getRedis(): Promise<RedisLike | null> | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.CRUMB_REDIS_URL?.trim();
  if (!url) { redisClient = null; return null; }
  redisClient = (async () => {
    try {
      // String-typed specifier + webpackIgnore: ioredis is optional and only
      // installed on Cloud, so neither tsc nor webpack resolves it here.
      const specifier: string = "ioredis";
      const mod = (await import(/* webpackIgnore: true */ specifier)) as { default: new (u: string, o?: unknown) => RedisLike };
      const Redis = mod.default;
      return new Redis(url, {
        // A limiter must never hang a request waiting on Redis.
        commandTimeout: 1000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        time: new Date().toISOString(), level: "error", scope: "crumb/rate-limit",
        msg: "CRUMB_REDIS_URL set but ioredis unavailable, falling back to in-memory limiter",
        err: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  })();
  return redisClient;
}

// Test-only: reset the memoized client so env changes take effect.
export function __resetRedisForTests(): void {
  redisClient = undefined;
}

// Test-only: how many in-memory buckets are live (eviction check).
export function __bucketCountForTests(): number {
  return buckets.size;
}

// Async entry point. Uses Redis when configured + reachable; otherwise the
// in-memory bucket. This is what request handlers should call.
export async function checkRateLimitAsync(
  key: string,
  opts: { capacity?: number; refillPerSec?: number } = {},
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) return checkRateLimit(key, opts);

  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const refill = opts.refillPerSec ?? DEFAULT_REFILL_PER_SEC;
  try {
    const client = await redis;
    if (!client) return checkRateLimit(key, opts);
    const res = (await client.eval(BUCKET_LUA, 1, `rl:${key}`, capacity, refill, Date.now())) as [number, number, number];
    const [allowed, remaining, retry] = res;
    if (allowed === 1) return { ok: true, remaining };
    return { ok: false, retryAfterSeconds: Math.max(1, retry) };
  } catch {
    // Redis blip — fall back to the local bucket so the request still gets
    // a bounded, deterministic answer.
    return checkRateLimit(key, opts);
  }
}

// Best-effort caller fingerprint, preferring what the client can't forge past
// our proxy: CF-Connecting-IP (Cloudflare overwrites it; Cloud and the DEPLOY.md
// self-host sit behind a Cloudflare Tunnel), then X-Real-IP, then the LAST
// X-Forwarded-For hop (the one the nearest proxy appended; earlier entries are
// whatever the client sent). Falls back to "anon" so the limiter still applies
// (whole population shares the bucket — fine for tiny self-host instances).
// ponytail: the first two are trusted as sent, so the app must only be
// reachable through Cloudflare or a proxy that overwrites both (README "Rate
// limiting"). Gate them behind an opt-in env if that ever can't hold.
export function callerIpFromRequest(req: Request): string {
  return callerIpFromHeaders(req.headers);
}

// Same, for server actions (next/headers) that have no Request.
export function callerIpFromHeaders(h: { get(name: string): string | null }): string {
  return (
    h.get("cf-connecting-ip")?.trim() ||
    h.get("x-real-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "anon"
  );
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
