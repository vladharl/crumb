import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  seal,
  open,
  sealNullable,
  openNullable,
  isEncryptionConfigured,
  __resetKeyringForTests,
} from "@/lib/crypto-at-rest";

// 32-byte key as 64 hex chars.
const KEY = "0".repeat(64);
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

function setKey(value?: string, id?: string) {
  if (value === undefined) delete process.env.CRUMB_ENCRYPTION_KEY;
  else process.env.CRUMB_ENCRYPTION_KEY = value;
  if (id === undefined) delete process.env.CRUMB_ENCRYPTION_KEY_ID;
  else process.env.CRUMB_ENCRYPTION_KEY_ID = id;
  __resetKeyringForTests();
}

describe("lib/crypto-at-rest", () => {
  const original = process.env.CRUMB_ENCRYPTION_KEY;
  const originalId = process.env.CRUMB_ENCRYPTION_KEY_ID;

  beforeEach(() => setKey(KEY));
  afterEach(() => {
    // Restore whatever the environment had.
    setKey(original, originalId);
    for (const k of Object.keys(process.env)) {
      if (/^CRUMB_ENCRYPTION_KEY_/.test(k) && k !== "CRUMB_ENCRYPTION_KEY_ID") delete process.env[k];
    }
    __resetKeyringForTests();
  });

  it("seals + opens a value round-trip", () => {
    const sealed = seal("xoxb-super-secret");
    expect(sealed).not.toBe("xoxb-super-secret");
    expect(sealed.startsWith("enc:1:")).toBe(true);
    expect(open(sealed)).toBe("xoxb-super-secret");
  });

  it("produces a fresh IV each call (no deterministic ciphertext)", () => {
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("accepts a base64 key too", () => {
    setKey(KEY_B64);
    expect(open(seal("hello"))).toBe("hello");
  });

  it("passes legacy plaintext through open() unchanged", () => {
    expect(open("plaintext-token")).toBe("plaintext-token");
  });

  it("is a no-op when no key is configured", () => {
    setKey(undefined);
    expect(isEncryptionConfigured()).toBe(false);
    expect(seal("token")).toBe("token");
    expect(open("token")).toBe("token");
  });

  it("throws on a tampered ciphertext (GCM auth tag)", () => {
    const sealed = seal("secret");
    const parts = sealed.split(":");
    // Flip the 2nd-to-last ciphertext char to a *different* char (base off the
    // char being replaced, so the change is always real — not the last char).
    const ct = parts[5];
    const i = ct.length - 2;
    parts[5] = ct.slice(0, i) + (ct[i] === "A" ? "B" : "A") + ct.slice(i + 1);
    expect(() => open(parts.join(":"))).toThrow();
  });

  it("throws when the named key is unavailable", () => {
    const sealed = seal("secret");
    setKey("1".repeat(64)); // different key, same id "1" → wrong key → GCM tag fails
    expect(() => open(sealed)).toThrow();
  });

  it("decrypts ciphertext sealed under a rotated (historical) key", () => {
    // Seal under key id "1".
    const sealed = seal("rotate-me");
    // Rotate: new current key id "2", keep old key available as _1.
    process.env.CRUMB_ENCRYPTION_KEY = "2".repeat(64);
    process.env.CRUMB_ENCRYPTION_KEY_ID = "2";
    process.env.CRUMB_ENCRYPTION_KEY_1 = KEY;
    __resetKeyringForTests();
    expect(open(sealed)).toBe("rotate-me");
    expect(seal("new").startsWith("enc:1:2:")).toBe(true);
  });

  it("nullable helpers pass null through", () => {
    expect(sealNullable(null)).toBeNull();
    expect(openNullable(null)).toBeNull();
    expect(openNullable(sealNullable("x"))).toBe("x");
  });
});
