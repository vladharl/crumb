import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { newApiKey, resolveApiKey, bearerFromRequest } from "@/lib/api-keys";

describe("lib/api-keys newApiKey", () => {
  it("produces a crumb_sk_ raw key with a matching sha256 hash and display prefix", () => {
    const k = newApiKey();
    expect(k.raw.startsWith("crumb_sk_")).toBe(true);
    expect(k.prefix).toBe(k.raw.slice(0, 16));
    expect(k.hash).toBe(createHash("sha256").update(k.raw).digest("hex"));
    expect(k.hash).toHaveLength(64);
  });

  it("generates unique keys each call", () => {
    const a = newApiKey();
    const b = newApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("lib/api-keys resolveApiKey (no-DB early returns)", () => {
  it("returns null for missing or non-Crumb tokens without querying", async () => {
    expect(await resolveApiKey(null)).toBeNull();
    expect(await resolveApiKey(undefined)).toBeNull();
    expect(await resolveApiKey("")).toBeNull();
    expect(await resolveApiKey("sk-not-a-crumb-key")).toBeNull();
    expect(await resolveApiKey("Bearer crumb_sk_x")).toBeNull(); // header not stripped
  });
});

describe("lib/api-keys bearerFromRequest", () => {
  it("extracts a bearer token", () => {
    const req = new Request("https://x/api/mcp", { headers: { authorization: "Bearer crumb_sk_abc" } });
    expect(bearerFromRequest(req)).toBe("crumb_sk_abc");
  });

  it("returns null when absent or not a Bearer scheme", () => {
    expect(bearerFromRequest(new Request("https://x"))).toBeNull();
    expect(bearerFromRequest(new Request("https://x", { headers: { authorization: "Basic xyz" } }))).toBeNull();
  });
});
