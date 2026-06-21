import { describe, it, expect } from "vitest";
import { isActiveStatus, lookupKeyFor, planIdFromLookupKey } from "@/lib/stripe";

describe("lib/stripe lookupKeyFor", () => {
  it("builds <plan>_<monthly|annual> keys", () => {
    expect(lookupKeyFor("team", "month")).toBe("team_monthly");
    expect(lookupKeyFor("team", "year")).toBe("team_annual");
    expect(lookupKeyFor("growth", "month")).toBe("growth_monthly");
    expect(lookupKeyFor("growth", "year")).toBe("growth_annual");
  });
});

describe("lib/stripe planIdFromLookupKey", () => {
  it("derives the plan prefix regardless of interval", () => {
    expect(planIdFromLookupKey("team_monthly")).toBe("team");
    expect(planIdFromLookupKey("team_annual")).toBe("team");
    expect(planIdFromLookupKey("growth_monthly")).toBe("growth");
    expect(planIdFromLookupKey("growth_annual")).toBe("growth");
  });

  it("round-trips with lookupKeyFor for every plan × interval", () => {
    for (const plan of ["team", "growth"] as const) {
      for (const interval of ["month", "year"] as const) {
        expect(planIdFromLookupKey(lookupKeyFor(plan, interval))).toBe(plan);
      }
    }
  });

  it("fails closed to 'unknown' for unmapped / missing keys", () => {
    expect(planIdFromLookupKey("enterprise_monthly")).toBe("unknown");
    expect(planIdFromLookupKey("price_1Abc")).toBe("unknown"); // raw Stripe price id
    expect(planIdFromLookupKey(null)).toBe("unknown");
    expect(planIdFromLookupKey(undefined)).toBe("unknown");
    expect(planIdFromLookupKey("")).toBe("unknown");
  });
});

describe("lib/stripe isActiveStatus", () => {
  it("returns true for active, trialing, past_due", () => {
    expect(isActiveStatus("active")).toBe(true);
    expect(isActiveStatus("trialing")).toBe(true);
    expect(isActiveStatus("past_due")).toBe(true);
  });

  it("returns false for canceled, incomplete, unpaid, paused", () => {
    expect(isActiveStatus("canceled")).toBe(false);
    expect(isActiveStatus("incomplete")).toBe(false);
    expect(isActiveStatus("unpaid")).toBe(false);
    expect(isActiveStatus("paused")).toBe(false);
  });

  it("returns false for null / undefined / empty string (free tier)", () => {
    expect(isActiveStatus(null)).toBe(false);
    expect(isActiveStatus(undefined)).toBe(false);
    expect(isActiveStatus("")).toBe(false);
  });
});
