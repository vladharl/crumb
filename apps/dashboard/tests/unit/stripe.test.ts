import { describe, it, expect, afterEach } from "vitest";
import {
  isActiveStatus, lookupKeyFor, planIdFromLookupKey,
  stripeKeyMode, stripeKeyMisconfigured,
} from "@/lib/stripe";

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

describe("lib/stripe stripeKeyMode", () => {
  const origKey = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = origKey;
  });

  it("returns null when no key is configured", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(stripeKeyMode()).toBe(null);
  });

  it("reads live mode from the sk_live_ / rk_live_ prefix", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
    expect(stripeKeyMode()).toBe("live");
    process.env.STRIPE_SECRET_KEY = "rk_live_abc123";
    expect(stripeKeyMode()).toBe("live");
  });

  it("treats sk_test_ (and anything non-live) as test", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    expect(stripeKeyMode()).toBe("test");
  });

  it("trims surrounding whitespace before reading the prefix", () => {
    process.env.STRIPE_SECRET_KEY = "  sk_live_abc  ";
    expect(stripeKeyMode()).toBe("live");
  });
});

describe("lib/stripe stripeKeyMisconfigured", () => {
  const origKey = process.env.STRIPE_SECRET_KEY;
  const origTier = process.env.CRUMB_TIER;
  afterEach(() => {
    if (origKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = origKey;
    if (origTier === undefined) delete process.env.CRUMB_TIER;
    else process.env.CRUMB_TIER = origTier;
  });

  it("is true only for a test key on the Cloud tier", () => {
    process.env.CRUMB_TIER = "cloud";
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    expect(stripeKeyMisconfigured()).toBe(true);
  });

  it("is false for a live key on Cloud", () => {
    process.env.CRUMB_TIER = "cloud";
    process.env.STRIPE_SECRET_KEY = "sk_live_abc";
    expect(stripeKeyMisconfigured()).toBe(false);
  });

  it("is false on self-host even with a test key (expected there)", () => {
    process.env.CRUMB_TIER = "self_host";
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    expect(stripeKeyMisconfigured()).toBe(false);
  });

  it("is false on Cloud when no key is set (caught by stripeConfigured instead)", () => {
    process.env.CRUMB_TIER = "cloud";
    delete process.env.STRIPE_SECRET_KEY;
    expect(stripeKeyMisconfigured()).toBe(false);
  });
});
