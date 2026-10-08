import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, callerIpFromRequest, clientIpFromHeaders, __bucketCountForTests } from "@/lib/rate-limit";
import { startSignup } from "@/ee/app/signup/actions";
import { POST as postReplayChunk } from "@/ee/app/api/v1/replay-sessions/[id]/chunks/route";

// Per-IP limits key on callerIpFromRequest. Behind Cloudflare the client
// controls the FIRST X-Forwarded-For entry, so keying on it let anyone mint a
// fresh bucket per request. And the in-memory Map must shed idle buckets, or it
// grows with every key ever seen.

// Self-serve signup's per-IP cap counts pending signups by their stored ip; the
// request headers and the pending-signup store are faked.
const signup = vi.hoisted(() => ({ headers: new Headers(), ips: [] as Array<string | null | undefined> }));
vi.mock("next/headers", () => ({ headers: () => signup.headers }));
vi.mock("@crumb/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crumb/db")>()),
  countRecentSignups: async () => 0,
  createPendingSignup: async (p: { ip?: string | null }) => { signup.ips.push(p.ip); return "token"; },
}));
vi.mock("@/lib/provision", () => ({ ensureUniqueSlug: async (slug: string) => slug }));
vi.mock("@/lib/email", () => ({ sendSignupVerify: async () => true }));
// The address Turnstile checks and a replay stores, faked at both ends.
const seen = vi.hoisted(() => ({ turnstile: [] as Array<string | null | undefined>, replay: [] as Array<string | null | undefined> }));
vi.mock("@/lib/turnstile", () => ({
  verifyTurnstile: async (_token: string, ip?: string | null) => { seen.turnstile.push(ip); return true; },
}));
vi.mock("@/lib/replay/ingest", () => ({
  recordChunk: async (input: { callerIp?: string | null }) => {
    seen.replay.push(input.callerIp);
    return { ok: true, sessionId: "session-1", chunkId: "chunk-1" };
  },
}));

const ip = (headers: Record<string, string>) =>
  callerIpFromRequest(new Request("https://crumb.test/api/v1/items", { headers }));

describe("lib/rate-limit callerIpFromRequest", () => {
  it("keys on CF-Connecting-IP, then X-Real-IP, then the last X-Forwarded-For hop", () => {
    // A spoofed first X-Forwarded-For entry doesn't move the key.
    expect(ip({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1, 203.0.113.7" })).toBe("203.0.113.7");
    expect(ip({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "9.9.9.9, 203.0.113.7" })).toBe("203.0.113.7");
    expect(ip({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "9.9.9.9, 198.51.100.3" })).toBe("198.51.100.2");
    expect(ip({ "x-forwarded-for": "9.9.9.9, 198.51.100.3" })).toBe("198.51.100.3");
    expect(ip({})).toBe("anon");
  });

  it("keys an IPv6 caller on its /64, so rotating through it doesn't mint buckets", () => {
    for (const addr of ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:0DB8:1:2::1", "2001:db8:1:2:3:4:1.2.3.4"]) {
      expect(ip({ "cf-connecting-ip": addr })).toBe("2001:db8:1:2::");
    }
    expect(ip({ "cf-connecting-ip": "2001:db8:1:3::1" })).toBe("2001:db8:1:3::"); // the next /64 is someone else
    expect(ip({ "cf-connecting-ip": "2001:db8::1" })).toBe("2001:db8:0:0::");
    // An IPv4 client seen through a dual-stack socket is that IPv4 client.
    expect(ip({ "x-forwarded-for": "9.9.9.9, ::ffff:203.0.113.7" })).toBe("203.0.113.7");
    expect(ip({ "cf-connecting-ip": "fe80::1%eth0" })).toBe("fe80::1%eth0");
  });
});

describe("self-serve signup per-IP cap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keys on the same address, not a spoofable first X-Forwarded-For entry", async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    vi.stubEnv("CRUMB_APP_URL", "https://crumb.test");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    for (const spoofed of ["1.1.1.1", "9.9.9.9"]) {
      signup.headers = new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `${spoofed}, 203.0.113.7` });
      const form = new FormData();
      form.set("workspaceName", "Acme");
      form.set("adminName", "Pat");
      form.set("adminEmail", `pat-${spoofed}@acme.test`);
      form.set("acceptedTerms", "on");
      expect(await startSignup(form)).toEqual({ ok: true });
    }
    expect(signup.ips).toEqual(["203.0.113.7", "203.0.113.7"]);
  });
});

// The /64 is a limiter key, not an address: what's kept or passed on as the
// caller's address stays the one they came from.
describe("the caller's own address", () => {
  afterEach(() => vi.unstubAllEnvs());
  const v6 = "2001:db8:1:2:aaaa:bbbb:cccc:dddd";

  it("is the trusted header's address, unbucketed, or null without one", () => {
    expect(clientIpFromHeaders(new Headers({ "cf-connecting-ip": v6, "x-forwarded-for": "9.9.9.9" }))).toBe(v6);
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "9.9.9.9, 198.51.100.3" }))).toBe("198.51.100.3");
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  it("is what a replay stores and Turnstile checks, while their limits key on the /64", async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    vi.stubEnv("CRUMB_APP_URL", "https://crumb.test");
    const chunk = new Request("https://crumb.test/api/v1/replay-sessions/x/chunks", {
      method: "POST",
      headers: { "cf-connecting-ip": v6, "content-type": "application/json" },
      body: JSON.stringify({
        workspace_slug: "acme", sequence: 0, events: [{}],
        started_at: "2026-10-08T10:00:00.000Z", ended_at: "2026-10-08T10:00:05.000Z",
      }),
    });
    expect((await postReplayChunk(chunk, { params: { id: "a".repeat(32) } })).status).toBe(201);
    expect(seen.replay).toEqual([v6]);

    signup.headers = new Headers({ "cf-connecting-ip": v6 });
    const form = new FormData();
    form.set("workspaceName", "Acme");
    form.set("adminName", "Pat");
    form.set("adminEmail", "pat-v6@acme.test");
    form.set("acceptedTerms", "on");
    expect(await startSignup(form)).toEqual({ ok: true });
    expect(seen.turnstile.at(-1)).toBe(v6);
    expect(signup.ips.at(-1)).toBe("2001:db8:1:2::");
  });
});

describe("lib/rate-limit idle-bucket eviction", () => {
  afterEach(() => vi.useRealTimers());

  it("drops buckets that refilled to capacity and keeps ones still limiting", () => {
    vi.useFakeTimers();
    // Buckets earlier tests left (the replay route's) are idle and go too.
    const before = __bucketCountForTests();
    const opts = { capacity: 2, refillPerSec: 1 };
    for (let i = 0; i < 100; i++) checkRateLimit(`idle:${i}`, opts);
    const slow = { capacity: 1, refillPerSec: 0.001 };
    checkRateLimit("drained", slow);
    expect(checkRateLimit("drained", slow).ok).toBe(false);
    expect(__bucketCountForTests()).toBe(before + 101);

    vi.advanceTimersByTime(5_000); // every idle:* bucket is full again
    for (let i = 0; i < 10_000 && __bucketCountForTests() > 2; i++) checkRateLimit("busy", opts);

    expect(__bucketCountForTests()).toBe(2); // "drained" + "busy"
    expect(checkRateLimit("drained", slow).ok).toBe(false); // eviction never resets a live limit
  });
});
