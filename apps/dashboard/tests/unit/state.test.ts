import { describe, it, expect, beforeAll } from "vitest";
import { signState, verifyState } from "@/lib/integrations/state";

const WS_ID = "f20454c8-62f5-4325-9bf2-b65933d18b46";

beforeAll(() => {
  // The HMAC key falls back through several env names. Set a stable one
  // for the duration of this test file so the assertions are deterministic.
  process.env.CRUMB_OAUTH_STATE_SECRET = "test-state-secret";
});

describe("lib/integrations/state", () => {
  it("signs + verifies a Linear state round-trip", () => {
    const state = signState("linear", WS_ID);
    const r = verifyState("linear", state);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspaceId).toBe(WS_ID);
  });

  it("rejects a Linear state replayed against Jira", () => {
    const linearState = signState("linear", WS_ID);
    const r = verifyState("jira", linearState);
    expect(r.ok).toBe(false);
  });

  it("rejects a tampered signature tail", () => {
    const state = signState("github", WS_ID);
    const tampered = state.slice(0, -1) + (state.at(-1) === "A" ? "B" : "A");
    const r = verifyState("github", tampered);
    expect(r.ok).toBe(false);
  });

  it("rejects malformed state shape", () => {
    expect(verifyState("linear", "missing.parts").ok).toBe(false);
    expect(verifyState("linear", "").ok).toBe(false);
    // Wrong shape: 3 parts instead of 4 (provider.workspaceId.nonce.sig).
    expect(verifyState("linear", "linear.wsid.nonce").ok).toBe(false);
  });

  it("two sequential sign calls yield different states (nonce changes)", () => {
    const a = signState("linear", WS_ID);
    const b = signState("linear", WS_ID);
    expect(a).not.toBe(b);
    // Both still verify.
    expect(verifyState("linear", a).ok).toBe(true);
    expect(verifyState("linear", b).ok).toBe(true);
  });
});
