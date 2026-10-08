import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Self-serve signup's emailed link. Mail scanners open links, so opening one
// must never create anything; the Create button's POST creates the workspace
// exactly once; resends are capped per address; an expired link prefills the
// form and one click sends a fresh link. The pending-signup store, workspace
// provisioning, sessions and email are faked.

type Row = {
  id: string; token: string; workspaceName: string; slug: string; adminName: string;
  adminEmail: string; ip: string | null; expiresAt: Date; consumedAt: Date | null; createdAt: Date;
};

const h = vi.hoisted(() => ({ rows: [] as Row[], created: 0, links: [] as string[], sendOk: true }));

function row(over: Partial<Row>): Row {
  const r: Row = {
    id: `row-${h.rows.length + 1}`, token: `t${h.rows.length + 1}`, workspaceName: "Acme", slug: "acme",
    adminName: "Pat", adminEmail: "pat@acme.test", ip: null,
    expiresAt: new Date(Date.now() + 30 * 60_000), consumedAt: null, createdAt: new Date(), ...over,
  };
  h.rows.push(r);
  return r;
}

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "crumb_session",
  createSession: async () => ({ cookieValue: "fresh-session", expiresAt: new Date(Date.now() + 60_000) }),
}));
vi.mock("@/lib/provision", () => ({
  ensureUniqueSlug: async (slug: string) => slug,
  createWorkspaceWithAdmin: async (p: { slug: string }) => {
    h.created++;
    return { workspace: { id: "ws-1", slug: p.slug }, user: { id: "user-1" } };
  },
}));
vi.mock("@/lib/email", () => ({
  sendSignupVerify: async (m: { link: string }) => { h.links.push(m.link); return h.sendOk; },
  sendSignupNotification: async () => undefined,
}));
vi.mock("@crumb/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crumb/db")>()),
  createPendingSignup: async (p: Partial<Row>) => row({ ...p, token: `minted-${h.rows.length + 1}` }).token,
}));
// Stands in for the UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
// claim: only a live, unused token can be spent, and only once.
vi.mock("@/ee/app/signup/pending", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ee/app/signup/pending")>()),
  claimPendingSignup: async (token: string) => {
    const r = h.rows.find((x) => x.token === token && !x.consumedAt && x.expiresAt > new Date());
    if (r) r.consumedAt = new Date();
    return r ?? null;
  },
  releasePendingSignup: async (id: string) => {
    const r = h.rows.find((x) => x.id === id);
    if (r) r.consumedAt = null;
  },
  findOpenPendingSignup: async (by: { token: string } | { email: string; workspaceName: string }) =>
    h.rows.filter((x) => !x.consumedAt && ("token" in by
      ? x.token === by.token
      : x.adminEmail === by.email && x.workspaceName === by.workspaceName)).at(-1) ?? null,
}));

import { GET, POST } from "@/ee/app/signup/verify/route";
import { resendSignup } from "@/ee/app/signup/actions";
import SignupPage from "@/ee/app/signup/page";

// The unit config compiles JSX to React.createElement without importing React.
const render = async (searchParams: Record<string, string>) => {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(await SignupPage({ searchParams }));
};

beforeEach(() => {
  vi.stubEnv("CRUMB_TIER", "cloud");
  vi.stubEnv("CRUMB_APP_URL", "https://crumb.test");
  h.rows.length = 0;
  h.links.length = 0;
  h.created = 0;
  h.sendOk = true;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("signup confirm link", () => {
  it("opening the link (page or the old /signup/verify GET) creates nothing", async () => {
    const link = row({ token: "scanned" });

    const old = await GET(new Request("https://crumb.test/signup/verify?token=scanned&plan=team&interval=year"));
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("https://crumb.test/signup?token=scanned&plan=team&interval=year");

    const html = await render({ token: "scanned", plan: "team", interval: "year" });
    expect(html).toContain('action="/signup/verify"'); // the Create button's form
    expect(html).toContain('name="plan" value="team"');
    expect(link.consumedAt).toBeNull();
    expect(h.created).toBe(0);
  });

  it("the Create button's POST creates the workspace once, then the link is spent", async () => {
    row({ token: "live" });
    const post = (site = "same-origin") => POST(new Request("https://crumb.test/signup/verify", {
      method: "POST",
      headers: { "sec-fetch-site": site },
      body: new URLSearchParams({ token: "live", plan: "team", interval: "year" }),
    }));
    const back = "https://crumb.test/signup?token=live&plan=team&interval=year";

    // Another site can't post the form for a visitor (login CSRF).
    expect((await post("cross-site")).headers.get("location")).toBe(back);
    expect(h.created).toBe(0);

    const first = await post();
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("https://crumb.test/settings/billing?plan=team&interval=year");
    expect(first.headers.get("set-cookie")).toContain("crumb_session=fresh-session");

    const again = await post(); // double click, second tab, back + resubmit
    expect(again.headers.get("location")).toBe(back);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(h.created).toBe(1);
  });

  it("resends the same link, capped per address", async () => {
    row({ token: "pending", adminEmail: "sam@acme.test" });
    const resend = () => resendSignup({ workspaceName: "Acme", adminEmail: "Sam@acme.test" });

    for (let i = 0; i < 3; i++) expect(await resend()).toEqual({ ok: true });
    expect(await resend()).toEqual({ ok: false, error: expect.stringContaining("a few links already") });
    expect(h.links.map((l) => new URL(l).searchParams.get("token"))).toEqual(["pending", "pending", "pending"]);
  });

  it("says the email didn't go when the provider refuses it", async () => {
    row({ token: "pending", adminEmail: "lee@acme.test" });
    h.sendOk = false; // e.g. Resend 422 for a bad recipient, or any SMTP failure
    expect(await resendSignup({ workspaceName: "Acme", adminEmail: "lee@acme.test" }))
      .toEqual({ ok: false, error: expect.stringContaining("couldn't send the email to lee@acme.test") });
  });

  it("an expired link prefills the form, and one click mails a fresh link", async () => {
    row({ token: "stale", adminEmail: "kim@acme.test", adminName: "Kim", expiresAt: new Date(Date.now() - 60_000) });

    const html = await render({ token: "stale", plan: "growth", interval: "month" });
    expect(html).toContain("That link expired.");
    expect(html).not.toContain('action="/signup/verify"');
    for (const v of ['value="Acme"', 'value="Kim"', 'value="kim@acme.test"', 'name="plan" value="growth"']) {
      expect(html).toContain(v);
    }

    expect(await resendSignup({ workspaceName: "Acme", adminEmail: "kim@acme.test", plan: "growth", interval: "month" }))
      .toEqual({ ok: true });
    const link = new URL(h.links[0]!);
    expect(link.pathname).toBe("/signup");
    expect(link.searchParams.get("token")).toMatch(/^minted-/); // a stale token is replaced, never revived
    expect(link.searchParams.get("plan")).toBe("growth");
    expect(link.searchParams.get("interval")).toBe("month");
  });
});
