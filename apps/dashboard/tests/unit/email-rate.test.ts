import { afterEach, describe, expect, it, vi } from "vitest";
import { makeResendProvider } from "@/lib/email/resend";

// Resend allows 2 requests a second by default and answers 429 past that.
// lib/email starts every real send at the next free slot of one process-wide
// budget (CRUMB_EMAIL_SENDS_PER_SEC), and the Resend adapter retries a 429
// after its Retry-After, a few times at most.

const email = { to: "pat@initech.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };
const limited = (retryAfter: string) =>
  new Response('{"name":"rate_limit_exceeded"}', { status: 429, headers: { "retry-after": retryAfter } });
// fetch answers with `responses` in order, then accepts.
const answers = (...responses: Response[]) => {
  const fetch = vi.fn(async () => responses.shift() ?? Response.json({ id: "re_1" }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("email rate", () => {
  it("resend retries a 429 after its Retry-After, three sends at most", async () => {
    const resend = makeResendProvider({ apiKey: "re_test", from: "Acme <crumb@acme.test>" });

    let fetch = answers(limited("0.01"), limited("0.01"));
    expect(await resend.send(email)).toEqual({ ok: true, providerMessageId: "re_1" });
    expect(fetch).toHaveBeenCalledTimes(3);

    fetch = answers(limited("0.01"), limited("0.01"), limited("0.01"));
    expect(await resend.send(email)).toMatchObject({ ok: false, error: "resend_429" });
    expect(fetch).toHaveBeenCalledTimes(3);

    // A spent daily quota (a Retry-After past the wait budget) and any other
    // error fail at once.
    fetch = answers(limited("3600"));
    expect(await resend.send(email)).toMatchObject({ ok: false, error: "resend_429" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch = answers(new Response("{}", { status: 422 }));
    expect(await resend.send(email)).toMatchObject({ ok: false, error: "resend_422" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("paces every real send in the process, blank meaning 2 a second, and never stdout", async () => {
    // A fresh lib/email, so it picks its provider from the env set before.
    const fresh = () => { vi.resetModules(); return import("@/lib/email"); };
    const burst = ({ sendMagicLink }: typeof import("@/lib/email"), n: number) => Promise.all(
      Array.from({ length: n }, (_, i) => sendMagicLink({ to: `u${i}@acme.test`, link: "https://crumb.test/l", ttlMinutes: 15 })),
    );

    // stdout prints, so a burst goes out at once (paced, it would take 1.5s).
    vi.stubEnv("CRUMB_EMAIL_PROVIDER", "");
    vi.stubEnv("CRUMB_EMAIL_SENDS_PER_SEC", "");
    let email = await fresh();
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = Date.now();
    await burst(email, 4);
    expect(print).toHaveBeenCalledTimes(4);
    expect(Date.now() - start).toBeLessThan(400);
    print.mockRestore();

    // A real provider: concurrent callers take turns, 1000/rate ms apart.
    vi.stubEnv("CRUMB_TIER", "cloud");
    vi.stubEnv("CRUMB_EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CRUMB_EMAIL_FROM", "Acme <crumb@acme.test>");
    vi.stubEnv("CRUMB_EMAIL_SENDS_PER_SEC", "20");
    const at: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { at.push(Date.now()); return Response.json({ id: "re_1" }); }));
    email = await fresh();
    await burst(email, 4);
    expect(at).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(at[i] - at[0]).toBeGreaterThanOrEqual(i * 50 - 10);

    // A blank value reads as unset: 2 a second.
    vi.stubEnv("CRUMB_EMAIL_SENDS_PER_SEC", " ");
    at.length = 0;
    await burst(email, 2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(490);
  });
});
