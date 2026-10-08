import { describe, it, expect, afterEach } from "vitest";
import {
  hasFeature,
  workspacePlan,
  integrationsAllowed,
  usageAnalyticsAllowed,
} from "@/lib/entitlements";

// `isCloud()` / `isActiveStatus()` read process.env live (no caching), so we
// drive the tier per-test via CRUMB_TIER and restore it after each.
const ORIGINAL_TIER = process.env.CRUMB_TIER;
afterEach(() => {
  if (ORIGINAL_TIER === undefined) delete process.env.CRUMB_TIER;
  else process.env.CRUMB_TIER = ORIGINAL_TIER;
});
function setTier(t: "cloud" | "self_host") {
  process.env.CRUMB_TIER = t;
}
function ws(planId: string, subscriptionStatus: string | null) {
  return { planId, subscriptionStatus };
}

describe("lib/entitlements", () => {
  describe("self-host (CRUMB_TIER unset / self_host)", () => {
    it("locks every gated feature regardless of plan columns", () => {
      setTier("self_host");
      const w = ws("growth", "active"); // even if columns look paid
      expect(hasFeature(w, "ai")).toBe(false);
      expect(hasFeature(w, "session_record")).toBe(false);
      expect(hasFeature(w, "integrations")).toBe(false);
    });

    it("reports plan 'free'", () => {
      setTier("self_host");
      expect(workspacePlan(ws("growth", "active"))).toBe("free");
    });

    it("allows integrations (creds-gated separately by *Configured())", () => {
      setTier("self_host");
      expect(integrationsAllowed(ws("free", null))).toBe(true);
    });

    it("allows usage analytics ingestion (capability-gated like integrations)", () => {
      setTier("self_host");
      // The AI usage-query path still gates on hasFeature(ws,"ai") (false here);
      // ingestion + non-AI surfaces are allowed so self-host gets real value.
      expect(usageAnalyticsAllowed(ws("free", null))).toBe(true);
    });
  });

  describe("cloud", () => {
    it("free plan unlocks nothing", () => {
      setTier("cloud");
      const w = ws("free", "active");
      expect(workspacePlan(w)).toBe("free");
      expect(hasFeature(w, "ai")).toBe(false);
      expect(hasFeature(w, "session_record")).toBe(false);
      expect(integrationsAllowed(w)).toBe(false);
    });

    it("team plan unlocks ai + integrations but not session_record", () => {
      setTier("cloud");
      const w = ws("team", "active");
      expect(workspacePlan(w)).toBe("team");
      expect(hasFeature(w, "ai")).toBe(true);
      expect(hasFeature(w, "integrations")).toBe(true);
      expect(hasFeature(w, "session_record")).toBe(false);
      expect(integrationsAllowed(w)).toBe(true);
    });

    it("growth plan unlocks everything", () => {
      setTier("cloud");
      const w = ws("growth", "active");
      for (const f of ["ai", "integrations", "session_record", "usage_analytics"] as const) expect(hasFeature(w, f)).toBe(true);
    });

    it("usage analytics requires the plan feature on cloud", () => {
      setTier("cloud");
      expect(usageAnalyticsAllowed(ws("free", "active"))).toBe(false);
      expect(usageAnalyticsAllowed(ws("team", "active"))).toBe(true);
      expect(usageAnalyticsAllowed(ws("growth", "active"))).toBe(true);
    });

    it("treats trialing + past_due as active (paid access)", () => {
      setTier("cloud");
      expect(hasFeature(ws("team", "trialing"), "ai")).toBe(true);
      expect(hasFeature(ws("team", "past_due"), "ai")).toBe(true);
    });

    it("collapses to free when subscription is canceled / missing", () => {
      setTier("cloud");
      expect(workspacePlan(ws("growth", "canceled"))).toBe("free");
      expect(workspacePlan(ws("growth", null))).toBe("free");
      expect(hasFeature(ws("growth", "canceled"), "session_record")).toBe(false);
    });

    it("fails closed on an unknown plan_id (raw price id, typo)", () => {
      setTier("cloud");
      expect(workspacePlan(ws("price_1QxYz", "active"))).toBe("free");
      expect(hasFeature(ws("price_1QxYz", "active"), "ai")).toBe(false);
    });
  });
});
