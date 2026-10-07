import { describe, it, expect } from "vitest";
import { trailProgress } from "@crumb/ui";

describe("ui/trailProgress", () => {
  it("lights only 'heard' for a fresh item", () => {
    expect(trailProgress({ status: "open", vendorReplied: false })).toEqual({
      heard: true, answered: false, decided: false, closed: false,
    });
  });

  it("lights 'answered' once a vendor has replied", () => {
    expect(trailProgress({ status: "open", vendorReplied: true })).toEqual({
      heard: true, answered: true, decided: false, closed: false,
    });
  });

  it("treats review as still undecided", () => {
    expect(trailProgress({ status: "review", vendorReplied: true }).decided).toBe(false);
  });

  it("lights 'decided' for post-triage statuses without closing", () => {
    for (const status of ["planned", "progress", "deferred"]) {
      const p = trailProgress({ status, vendorReplied: true });
      expect(p.decided).toBe(true);
      expect(p.closed).toBe(false);
    }
  });

  it("lights the full trail when the loop closes", () => {
    for (const status of ["shipped", "declined", "duplicate", "resolved"]) {
      const p = trailProgress({ status, vendorReplied: true });
      expect(p.decided).toBe(true);
      expect(p.closed).toBe(true);
    }
  });
});
