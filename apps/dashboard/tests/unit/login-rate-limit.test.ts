import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requestMagicLink } from "@/app/login/actions";

// Every sign-in request mails a fresh link and kills the one before it, so an
// unthrottled form let anyone flood a teammate's inbox and keep their link
// dead, or spray links at every address they know. Now an address gets five an
// hour and an IP twenty. A limited request gets the same answer as a sent link,
// so the form never says whether an address has an account. Sending is faked.

const h = vi.hoisted(() => ({ headers: new Headers(), sent: [] as string[], warned: [] as string[] }));
vi.mock("next/headers", () => ({ headers: () => h.headers }));
vi.mock("@/lib/auth", () => ({
  issueMagicLink: async (email: string) => { h.sent.push(email); return { delivered: true }; },
  safeNextPath: () => null,
}));
vi.mock("@/lib/log", () => ({
  log: { debug: () => {}, info: () => {}, error: () => {}, warn: (msg: string) => { h.warned.push(msg); } },
}));

// ip null: no proxy header names the client.
function ask(email: string, ip: string | null) {
  h.headers = new Headers(ip ? { "cf-connecting-ip": ip } : {});
  const form = new FormData();
  form.set("email", email);
  return requestMagicLink(form);
}

describe("magic-link requests", () => {
  beforeAll(() => vi.stubEnv("CRUMB_APP_URL", "https://crumb.example.test"));
  afterAll(() => vi.unstubAllEnvs());

  it("mail an address five times an hour and serve an IP twenty, answering the same past either limit", async () => {
    for (let i = 0; i < 7; i++) expect(await ask("mia@vendor.test", "203.0.113.7")).toEqual({ ok: true });
    expect(h.sent).toEqual(Array(5).fill("mia@vendor.test"));
    // A fresh IP doesn't reset the address.
    expect(await ask("mia@vendor.test", "198.51.100.2")).toEqual({ ok: true });
    expect(h.sent).toHaveLength(5);

    // Spraying addresses from the first IP: its 7 requests above count too.
    for (let i = 0; i < 20; i++) expect(await ask(`user${i}@vendor.test`, "203.0.113.7")).toEqual({ ok: true });
    expect(h.sent).toHaveLength(5 + 13);
  });

  it("with no client IP, never pools everyone into one bucket: each address keeps its own five, and it says so once", async () => {
    const before = h.sent.length;
    for (let i = 0; i < 25; i++) expect(await ask(`direct${i}@vendor.test`, null)).toEqual({ ok: true });
    expect(h.sent.length - before).toBe(25);
    for (let i = 0; i < 6; i++) expect(await ask("direct0@vendor.test", null)).toEqual({ ok: true });
    expect(h.sent.filter(e => e === "direct0@vendor.test")).toHaveLength(5);
    expect(h.warned).toHaveLength(1);
  });
});
