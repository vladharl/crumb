import { describe, it, expect } from "vitest";
import { suggestAccount } from "@/lib/ai/match-account";
import { suggestAccount as suggestStub, matchAccountConfigured } from "@/lib/ai/match-account.community";

const accounts = [
  { id: "a1", name: "Acme Co" },
  { id: "a2", name: "Globex" },
];

describe("match-account heuristic (real module)", () => {
  it("matches by sender email domain", async () => {
    const r = await suggestAccount({ fromEmail: "casey@acme.co", fromName: null, subject: null, body: "hi" }, accounts);
    expect(r?.accountId).toBe("a1");
  });

  it("matches by name mention in subject/body", async () => {
    const r = await suggestAccount({ fromEmail: null, fromName: null, subject: "Globex needs export", body: "" }, accounts);
    expect(r?.accountId).toBe("a2");
  });

  it("returns null for an empty account list", async () => {
    const r = await suggestAccount({ fromEmail: "x@y.com", fromName: null, subject: null, body: "" }, []);
    expect(r).toBeNull();
  });
});

describe("match-account community stub", () => {
  it("is not configured and returns null", async () => {
    expect(matchAccountConfigured()).toBe(false);
    expect(await suggestStub({ fromEmail: "casey@acme.co", fromName: null, subject: null, body: "" }, accounts)).toBeNull();
  });
});
