import { describe, it, expect, afterEach } from "vitest";
import { currentPeriod, aiCap, replayBytesCap } from "@/lib/usage";

// Caps depend on workspacePlan(), which reads CRUMB_TIER + subscription status
// live. Drive the tier per-test and restore.
const ORIGINAL_TIER = process.env.CRUMB_TIER;
const ORIGINAL_AI = process.env.CRUMB_AI_MONTHLY_CAP;
const ORIGINAL_MB = process.env.CRUMB_REPLAY_MONTHLY_MB;
afterEach(() => {
  if (ORIGINAL_TIER === undefined) delete process.env.CRUMB_TIER; else process.env.CRUMB_TIER = ORIGINAL_TIER;
  if (ORIGINAL_AI === undefined) delete process.env.CRUMB_AI_MONTHLY_CAP; else process.env.CRUMB_AI_MONTHLY_CAP = ORIGINAL_AI;
  if (ORIGINAL_MB === undefined) delete process.env.CRUMB_REPLAY_MONTHLY_MB; else process.env.CRUMB_REPLAY_MONTHLY_MB = ORIGINAL_MB;
});
const ws = (planId: string, subscriptionStatus: string | null) => ({ planId, subscriptionStatus });

describe("lib/usage currentPeriod", () => {
  it("formats a UTC YYYY-MM key, zero-padded", () => {
    expect(currentPeriod(new Date("2026-05-09T00:00:00Z"))).toBe("2026-05");
    expect(currentPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    expect(currentPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("lib/usage caps", () => {
  it("self-host (no tier) has zero caps — feature never runs there", () => {
    delete process.env.CRUMB_TIER;
    expect(aiCap(ws("growth", "active"))).toBe(0);
    expect(replayBytesCap(ws("growth", "active"))).toBe(0);
  });

  it("applies per-plan AI caps on Cloud", () => {
    process.env.CRUMB_TIER = "cloud";
    expect(aiCap(ws("free", null))).toBe(0);
    expect(aiCap(ws("team", "active"))).toBe(2_000);
    expect(aiCap(ws("growth", "active"))).toBe(10_000);
  });

  it("collapses to free cap when the subscription is not active", () => {
    process.env.CRUMB_TIER = "cloud";
    expect(aiCap(ws("growth", "canceled"))).toBe(0);
  });

  it("replay bytes cap is growth-only and in bytes", () => {
    process.env.CRUMB_TIER = "cloud";
    expect(replayBytesCap(ws("team", "active"))).toBe(0);
    expect(replayBytesCap(ws("growth", "active"))).toBe(5_120 * 1024 * 1024);
  });

  it("env overrides the per-plan defaults for paid plans only", () => {
    process.env.CRUMB_TIER = "cloud";
    process.env.CRUMB_AI_MONTHLY_CAP = "500";
    process.env.CRUMB_REPLAY_MONTHLY_MB = "1024";
    expect(aiCap(ws("team", "active"))).toBe(500);
    expect(aiCap(ws("growth", "active"))).toBe(500);
    expect(aiCap(ws("free", null))).toBe(0); // free stays blocked
    expect(replayBytesCap(ws("growth", "active"))).toBe(1024 * 1024 * 1024);
  });
});
