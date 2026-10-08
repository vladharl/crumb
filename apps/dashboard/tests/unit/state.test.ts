import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { signState, verifyState } from "@/lib/integrations/state";

const WS_ID = "f20454c8-62f5-4325-9bf2-b65933d18b46";
const OTHER_WS_ID = "0b6f7c2e-9a51-4d8e-8f3a-2c1d5e7a9b10";

beforeAll(() => {
  // The HMAC key falls back through several env names. Set a stable one
  // for the duration of this test file so the assertions are deterministic.
  process.env.CRUMB_OAUTH_STATE_SECRET = "test-state-secret";
});

afterEach(() => {
  vi.useRealTimers();
});

// Swap one dot-separated field (provider.workspaceId.issuedAt.nonce.sig).
function withPart(state: string, index: number, value: string): string {
  const parts = state.split(".");
  parts[index] = value;
  return parts.join(".");
}

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

  it("rejects a state re-pointed at another workspace", () => {
    const state = signState("hubspot", WS_ID);
    expect(verifyState("hubspot", withPart(state, 1, OTHER_WS_ID)).ok).toBe(false);
  });

  it("expires 10 minutes after issue", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const state = signState("salesforce", WS_ID);

    vi.setSystemTime(new Date("2026-10-07T12:09:59Z"));
    expect(verifyState("salesforce", state).ok).toBe(true);
    vi.setSystemTime(new Date("2026-10-07T12:10:01Z"));
    expect(verifyState("salesforce", state).ok).toBe(false);
  });

  it("rejects a refreshed issued-at (the stamp is covered by the HMAC)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const state = signState("slack", WS_ID);

    vi.setSystemTime(new Date("2026-10-07T13:00:00Z"));
    expect(verifyState("slack", withPart(state, 2, String(Date.now()))).ok).toBe(false);
  });

  it("rejects malformed state shape", () => {
    expect(verifyState("linear", "missing.parts").ok).toBe(false);
    expect(verifyState("linear", "").ok).toBe(false);
    // Pre-expiry shape: 4 parts (provider.workspaceId.nonce.sig), no issued-at.
    expect(verifyState("linear", `linear.${WS_ID}.nonce.sig`).ok).toBe(false);
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
