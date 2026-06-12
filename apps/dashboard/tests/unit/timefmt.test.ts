import { describe, it, expect } from "vitest";
import { gmailTime } from "@/lib/timefmt";

// All cases pin `now` so the test is independent of when it runs. Times are
// constructed in local time (gmailTime compares calendar fields, not UTC).
const now = new Date(2026, 5, 12, 15, 30); // Jun 12 2026, 3:30 PM local

describe("lib/timefmt gmailTime", () => {
  it("shows time of day for today", () => {
    expect(gmailTime(new Date(2026, 5, 12, 14, 14).toISOString(), now)).toBe("2:14 PM");
    expect(gmailTime(new Date(2026, 5, 12, 9, 5).toISOString(), now)).toBe("9:05 AM");
  });

  it("shows time at the edges of today", () => {
    expect(gmailTime(new Date(2026, 5, 12, 0, 0).toISOString(), now)).toBe("12:00 AM");
    expect(gmailTime(new Date(2026, 5, 12, 23, 59).toISOString(), now)).toBe("11:59 PM");
  });

  it("shows month + day for earlier this year", () => {
    expect(gmailTime(new Date(2026, 5, 11, 23, 59).toISOString(), now)).toBe("Jun 11");
    expect(gmailTime(new Date(2026, 0, 2, 8, 0).toISOString(), now)).toBe("Jan 2");
  });

  it("shows a short date for previous years", () => {
    expect(gmailTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("12/31/25");
    expect(gmailTime(new Date(2024, 5, 12, 12, 0).toISOString(), now)).toBe("6/12/24");
  });

  it("treats the year boundary by calendar year, not proximity", () => {
    const nye = new Date(2026, 0, 1, 0, 10); // Jan 1 2026, 00:10
    expect(gmailTime(new Date(2025, 11, 31, 23, 55).toISOString(), nye)).toBe("12/31/25");
    expect(gmailTime(new Date(2026, 0, 1, 0, 5).toISOString(), nye)).toBe("12:05 AM");
  });
});
