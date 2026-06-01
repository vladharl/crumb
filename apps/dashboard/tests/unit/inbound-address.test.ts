import { describe, it, expect, beforeEach } from "vitest";
import { signInboxToken, verifyInboxToken, buildInboxAddress, parseInboxAddress } from "@/lib/inbound-address";

describe("lib/inbound-address", () => {
  beforeEach(() => {
    process.env.CRUMB_INBOUND_SECRET = "test-secret";
  });

  it("round-trips sign/verify", () => {
    const t = signInboxToken("southbeam");
    expect(verifyInboxToken("southbeam", t)).toBe(true);
  });

  it("rejects a tampered token or wrong slug", () => {
    const t = signInboxToken("southbeam");
    expect(verifyInboxToken("southbeam", t + "x")).toBe(false);
    expect(verifyInboxToken("other", t)).toBe(false);
  });

  it("fails closed without a secret", () => {
    delete process.env.CRUMB_INBOUND_SECRET;
    expect(verifyInboxToken("southbeam", "anything")).toBe(false);
  });

  it("builds + parses an address (incl. display-name form)", () => {
    process.env.CRUMB_INBOUND_SECRET = "test-secret";
    const addr = buildInboxAddress("southbeam", "crumb.test");
    const parsed = parseInboxAddress(`Casey <${addr}>`);
    expect(parsed?.slug).toBe("southbeam");
    expect(parsed && verifyInboxToken(parsed.slug, parsed.token)).toBe(true);
  });

  it("ignores non-inbox addresses", () => {
    expect(parseInboxAddress("reply+FB-1.tok@crumb.test")).toBeNull();
    expect(parseInboxAddress("plain@crumb.test")).toBeNull();
  });
});
