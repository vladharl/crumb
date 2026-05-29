import { describe, it, expect } from "vitest";
import { isActiveStatus } from "@/lib/stripe";

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
