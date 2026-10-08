import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/login/verify/route";
import { requireSession, safeNextPath } from "@/lib/auth";

// Mail scanners open every link in an email, so a sign-in link spent on GET
// was burned before the person clicked. GET /login/verify now only forwards to
// the Continue page; that button's POST spends the token, once. `next` carries
// a deep link through sign-in, but only ever to a path on this origin. The DB
// and the request scope are faked.

const h = vi.hoisted(() => ({
  store: undefined as { urlPathname: string } | undefined,
  token: null as Record<string, unknown> | null,
  claimed: false,
  reads: 0,
  sessions: 0,
}));

// getSession is wrapped in React's server-only cache().
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock("next/dist/client/components/static-generation-async-storage.external", () => ({
  staticGenerationAsyncStorage: { getStore: () => h.store },
}));
vi.mock("@crumb/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crumb/db")>()),
  db: {
    // Always the token as first read (unconsumed), so a second POST models a
    // request that read the link just before the first one claimed it.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.reads++, h.token ? [h.token] : []) }) }) }),
    // UPDATE ... WHERE consumed_at IS NULL RETURNING id
    update: () => ({ set: () => ({ where: () => ({ returning: async () => (h.claimed ? [] : ((h.claimed = true), [{ id: "tok-1" }])) }) }) }),
    insert: () => ({ values: async () => { h.sessions++; } }),
  },
}));

const APP = "https://crumb.example.test";
// req.url is the internal service address behind the Cloudflare Tunnel.
const VERIFY = "http://0.0.0.0:3000/login/verify";

const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  POST(new Request(VERIFY, { method: "POST", body: new URLSearchParams(fields), headers }));

describe("magic-link sign-in", () => {
  beforeAll(() => vi.stubEnv("CRUMB_APP_URL", APP));
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => {
    h.token = { id: "tok-1", workspaceId: "ws-1", workspaceUserId: "user-1", consumedAt: null, expiresAt: new Date(Date.now() + 20 * 60_000) };
    h.claimed = false;
    h.reads = 0;
    h.sessions = 0;
  });

  it("GET spends nothing: it forwards token and next to the Continue page", () => {
    const res = GET(new Request(`${VERIFY}?token=tok&next=%2Fthread%2FFB-12`));
    expect(res.headers.get("location")).toBe(`${APP}/login/continue?token=tok&next=%2Fthread%2FFB-12`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.reads).toBe(0);
  });

  it("POST spends the link once: a 7-day session, then on to next", async () => {
    const first = await post({ token: "tok", next: "/thread/FB-12" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`${APP}/thread/FB-12`);
    const cookie = first.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^crumb_session=[\w-]+;.*HttpOnly/i);
    const expires = new Date(/Expires=([^;]+)/i.exec(cookie)?.[1] ?? 0).getTime();
    expect(Math.abs(expires - (Date.now() + 7 * 24 * 3600_000))).toBeLessThan(60_000);

    const second = await post({ token: "tok", next: "/thread/FB-12" });
    expect(second.headers.get("location")).toBe(`${APP}/login?e=consumed&next=%2Fthread%2FFB-12`);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(h.sessions).toBe(1);
  });

  it("POST drops a foreign next and refuses a cross-site or sibling-subdomain form", async () => {
    expect((await post({ token: "tok", next: "//evil.example/x" })).headers.get("location")).toBe(`${APP}/inbox`);

    h.claimed = false;
    for (const site of ["cross-site", "same-site"]) {
      const res = await post({ token: "tok" }, { "sec-fetch-site": site });
      expect(res.headers.get("location")).toBe(`${APP}/login?e=not_found`);
    }
    expect(h.claimed).toBe(false);
  });

  it.each([
    ["/thread/FB-12?tab=trail", "/thread/FB-12?tab=trail"],
    ["/inbox?_rsc=1x2y", "/inbox"],
    ["//evil.example", null],
    ["/\\evil.example", null],
    ["/..//evil.example", null],
    ["/\t/evil.example", null],
    ["https://evil.example", null],
    ["javascript:alert(1)", null],
    ["/login/verify?token=x", null],
    [undefined, null],
  ])("safeNextPath(%j) is %j", (raw, want) => {
    expect(safeNextPath(raw)).toBe(want);
  });

  it("the session guard sends a signed-out visitor to /login with the page they asked for", async () => {
    h.store = { urlPathname: "/thread/FB-12?tab=trail&_rsc=1x2y" };
    await expect(requireSession()).rejects.toMatchObject({
      digest: expect.stringContaining(";/login?next=%2Fthread%2FFB-12%3Ftab%3Dtrail;"),
    });

    h.store = undefined;
    await expect(requireSession()).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
  });
});
