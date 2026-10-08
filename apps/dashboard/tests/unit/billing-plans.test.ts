import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PLAN_FEATURES, PLAN_FEATURE_MAP, planDisplayName, type Feature, type Plan } from "@/lib/entitlements";
import { aiCap, replayBytesCap, usageEventsCap } from "@/lib/usage";

// The plan cards and upgrade notice render PLAN_FEATURES; the gates and caps
// live in PLAN_FEATURE_MAP and lib/usage.ts. These keep the copy honest.

const list = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock("stripe", () => ({ default: class { prices = { list }; } }));
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }));

const ORIGINAL = { tier: process.env.CRUMB_TIER, key: process.env.STRIPE_SECRET_KEY };
afterEach(() => {
  if (ORIGINAL.tier === undefined) delete process.env.CRUMB_TIER; else process.env.CRUMB_TIER = ORIGINAL.tier;
  if (ORIGINAL.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = ORIGINAL.key;
});

describe("PLAN_FEATURES", () => {
  it("lists each gated line on exactly the plans PLAN_FEATURE_MAP unlocks it for", () => {
    const plans = Object.keys(PLAN_FEATURE_MAP) as Plan[];
    const gates = new Set<Feature>(plans.flatMap(p => [...PLAN_FEATURE_MAP[p]]));
    for (const gate of gates) {
      const lines = PLAN_FEATURES.filter(f => f.feature === gate);
      expect(lines.length, `no customer-facing line for "${gate}"`).toBeGreaterThan(0);
      const unlockedOn = plans.filter(p => PLAN_FEATURE_MAP[p].includes(gate)).sort();
      for (const line of lines) expect([...line.plans].sort(), line.label).toEqual(unlockedOn);
    }
  });

  it("quotes the monthly caps lib/usage.ts enforces", () => {
    process.env.CRUMB_TIER = "cloud";
    const ws = (planId: string) => ({ planId, subscriptionStatus: "active" });
    const ai = PLAN_FEATURES.find(f => f.feature === "ai")!;
    expect(ai.limits?.team).toContain(aiCap(ws("team")).toLocaleString("en-US"));
    expect(ai.limits?.growth).toContain(aiCap(ws("growth")).toLocaleString("en-US"));
    const replay = PLAN_FEATURES.find(f => f.feature === "session_record")!;
    expect(replay.limits?.growth).toContain(`${replayBytesCap(ws("growth")) / 1024 ** 3} GB`);
    const events = PLAN_FEATURES.find(f => f.feature === "usage_analytics")!;
    expect(events.limits?.team).toContain(usageEventsCap(ws("team")).toLocaleString("en-US"));
    expect(events.limits?.growth).toContain(usageEventsCap(ws("growth")).toLocaleString("en-US"));
  });

  it("includes customer emails on every plan", () => {
    const emails = PLAN_FEATURES.find(f => /customer emails/i.test(f.label))!;
    expect([...emails.plans].sort()).toEqual(["free", "growth", "team"]);
    expect(emails.feature).toBeNull();
  });
});

describe("planDisplayName", () => {
  it("names known plans and reads anything else as Free", () => {
    expect(planDisplayName("free")).toBe("Free");
    expect(planDisplayName("team")).toBe("Team");
    expect(planDisplayName("growth")).toBe("Growth");
    expect(planDisplayName("unknown")).toBe("Free");
    expect(planDisplayName("price_1Abc")).toBe("Free");
    expect(planDisplayName(null)).toBe("Free");
  });
});

describe("planPrices", () => {
  // Fresh module per test: lib/stripe caches its client and the prices.
  beforeEach(() => { vi.resetModules(); list.mockReset(); warn.mockReset(); });
  const LIST = {
    team: { month: { amount: 2_400, currency: "usd" }, year: { amount: 22_800, currency: "usd" } },
    growth: { month: { amount: 4_900, currency: "usd" }, year: { amount: 46_800, currency: "usd" } },
  };

  it("shows list prices when Stripe isn't configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { planPrices } = await import("@/lib/stripe");
    expect(await planPrices()).toEqual(LIST);
    expect(list).not.toHaveBeenCalled();
  });

  it("reads Stripe prices by lookup_key, fills gaps from list prices, and caches", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    list.mockResolvedValue({ data: [{ lookup_key: "team_annual", unit_amount: 18_000, currency: "eur" }] });
    const { planPrices } = await import("@/lib/stripe");
    const prices = await planPrices();
    expect(prices.team.year).toEqual({ amount: 18_000, currency: "eur" });
    expect(prices.team.month).toEqual(LIST.team.month);
    expect(prices.growth).toEqual(LIST.growth);
    expect([...list.mock.calls[0][0].lookup_keys].sort())
      .toEqual(["growth_annual", "growth_monthly", "team_annual", "team_monthly"]);
    await planPrices();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("falls back to list prices when the Stripe lookup fails", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    list.mockRejectedValue(new Error("stripe down"));
    const { planPrices } = await import("@/lib/stripe");
    expect(await planPrices()).toEqual(LIST);
    expect(warn).toHaveBeenCalled();
  });
});
