import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaces } from "@crumb/db";
import { createFirstRunSetupToken, setupLinkFor } from "../../../../packages/db/src/setup-tokens";

// A fresh self-host has no workspace and invite-only sign-in, so the container
// entrypoint prints a one-time /onboard link (`cli first-run`). It must mint
// one only while no workspace exists: restarting a live instance must never
// print a fresh way in. The database is faked.
const fake = vi.hoisted(() => ({ from: null as unknown, workspaces: [] as { id: string }[], minted: [] as Array<{ token: string; expiresAt: Date }> }));
vi.mock("../../../../packages/db/src/client", () => ({
  db: {
    select: () => ({ from: (table: unknown) => { fake.from = table; return { limit: async () => fake.workspaces }; } }),
    insert: () => ({ values: async (row: { token: string; expiresAt: Date }) => { fake.minted.push(row); } }),
  },
}));

describe("first-run setup link", () => {
  beforeEach(() => { fake.from = null; fake.workspaces = []; fake.minted = []; });
  afterEach(() => vi.unstubAllEnvs());

  it("mints nothing once any workspace exists", async () => {
    fake.workspaces = [{ id: "ws-1" }];
    expect(await createFirstRunSetupToken(60 * 60_000)).toBeNull();
    expect(fake.from).toBe(workspaces);
    expect(fake.minted).toEqual([]);
  });

  it("mints a one-time token that lasts the given TTL on an empty instance", async () => {
    const token = await createFirstRunSetupToken(60 * 60_000);
    expect(token).toMatch(/^[\w-]{32}$/);
    expect(fake.minted).toHaveLength(1);
    expect(fake.minted[0].token).toBe(token);
    expect(fake.minted[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(fake.minted[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  it("builds the link from CRUMB_APP_URL, or prints just the path when it's unset", () => {
    expect(setupLinkFor("a b", "https://crumb.example.com/")).toBe("https://crumb.example.com/onboard?token=a%20b");
    expect(setupLinkFor("tok", "")).toBe("/onboard?token=tok");
    expect(setupLinkFor("tok", "  ")).toBe("/onboard?token=tok");
    vi.stubEnv("CRUMB_APP_URL", "http://localhost:3000");
    expect(setupLinkFor("tok")).toBe("http://localhost:3000/onboard?token=tok");
  });
});
