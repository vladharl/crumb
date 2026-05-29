import { describe, it, expect } from "vitest";
import { sign, verify } from "@/lib/jwt";

const SECRET = "test-secret-must-be-non-empty";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("lib/jwt", () => {
  it("signs + verifies a valid identity JWT round-trip", () => {
    const claims = {
      iss: "northbeam",
      sub: "lina@northbeam.io",
      name: "Lina Hsu",
      account_name: "Northbeam",
      exp: nowSec() + 3600,
      iat: nowSec(),
    };
    const token = sign(claims, SECRET);
    const r = verify(token, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.iss).toBe("northbeam");
      expect(r.claims.sub).toBe("lina@northbeam.io");
      expect(r.claims.account_name).toBe("Northbeam");
    }
  });

  it("rejects a token whose signature was tampered with", () => {
    const token = sign({
      iss: "northbeam",
      sub: "lina@northbeam.io",
      account_name: "Northbeam",
      exp: nowSec() + 3600,
    }, SECRET);
    // Flip the first character of the signature segment. Tampering the
    // last char can be a no-op for the decoded bytes (it encodes only
    // the trailing don't-care bits of the 32-byte HMAC); the head char
    // always meaningfully changes the byte stream.
    const parts = token.split(".");
    const head = parts[2][0];
    const swapped = head === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${swapped}${parts[2].slice(1)}`;
    const r = verify(tampered, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("signature");
  });

  it("rejects an expired token (past exp + skew)", () => {
    const token = sign({
      iss: "northbeam",
      sub: "lina@northbeam.io",
      account_name: "Northbeam",
      exp: nowSec() - 120, // 2 minutes ago — well past default 30s skew
    }, SECRET);
    const r = verify(token, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects a token signed with a different secret", () => {
    const token = sign({
      iss: "northbeam",
      sub: "lina@northbeam.io",
      account_name: "Northbeam",
      exp: nowSec() + 3600,
    }, SECRET);
    const r = verify(token, "other-secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("signature");
  });

  it("rejects malformed input shape", () => {
    expect(verify("not-a-jwt", SECRET).ok).toBe(false);
    expect(verify("a.b", SECRET).ok).toBe(false);
    expect(verify("", SECRET).ok).toBe(false);
  });
});
