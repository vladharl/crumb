import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, callerIpFromRequest, __bucketCountForTests } from "@/lib/rate-limit";
import { startSignup } from "@/ee/app/signup/actions";

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
vi.mock("@/lib/email", () => ({ sendSignupVerify: async () => undefined }));

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

describe("lib/rate-limit idle-bucket eviction", () => {
  afterEach(() => vi.useRealTimers());

  it("drops buckets that refilled to capacity and keeps ones still limiting", () => {
    vi.useFakeTimers();
    const opts = { capacity: 2, refillPerSec: 1 };
    for (let i = 0; i < 100; i++) checkRateLimit(`idle:${i}`, opts);
    const slow = { capacity: 1, refillPerSec: 0.001 };
    checkRateLimit("drained", slow);
    expect(checkRateLimit("drained", slow).ok).toBe(false);
    expect(__bucketCountForTests()).toBe(101);

    vi.advanceTimersByTime(5_000); // every idle:* bucket is full again
    for (let i = 0; i < 10_000 && __bucketCountForTests() > 2; i++) checkRateLimit("busy", opts);

    expect(__bucketCountForTests()).toBe(2); // "drained" + "busy"
    expect(checkRateLimit("drained", slow).ok).toBe(false); // eviction never resets a live limit
  });
});
