import { describe, it, expect } from "vitest";
import { formatDate, formatMonth, gmailTime } from "@/lib/timefmt";

// All cases pin `now` so the test is independent of when it runs. Times are
// constructed in local time (the helpers compare calendar fields, not UTC).
const now = new Date(2026, 5, 12, 15, 30); // 12 Jun 2026, 3:30 PM local

describe("lib/timefmt gmailTime", () => {
  it("shows time of day for today", () => {
    expect(gmailTime(new Date(2026, 5, 12, 14, 14).toISOString(), now)).toBe("2:14 PM");
    expect(gmailTime(new Date(2026, 5, 12, 9, 5).toISOString(), now)).toBe("9:05 AM");
  });

  it("shows time at the edges of today", () => {
    expect(gmailTime(new Date(2026, 5, 12, 0, 0).toISOString(), now)).toBe("12:00 AM");
    expect(gmailTime(new Date(2026, 5, 12, 23, 59).toISOString(), now)).toBe("11:59 PM");
  });

  it("shows day + month for earlier this year", () => {
    expect(gmailTime(new Date(2026, 5, 11, 23, 59).toISOString(), now)).toBe("11 Jun");
    expect(gmailTime(new Date(2026, 0, 2, 8, 0).toISOString(), now)).toBe("2 Jan");
  });

  it("adds the full year for previous years, never a numeric date", () => {
    expect(gmailTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("31 Dec 2025");
    expect(gmailTime(new Date(2024, 5, 12, 12, 0).toISOString(), now)).toBe("12 Jun 2024");
  });

  it("treats the year boundary by calendar year, not proximity", () => {
    const nye = new Date(2026, 0, 1, 0, 10); // 1 Jan 2026, 00:10
    expect(gmailTime(new Date(2025, 11, 31, 23, 55).toISOString(), nye)).toBe("31 Dec 2025");
    expect(gmailTime(new Date(2026, 0, 1, 0, 5).toISOString(), nye)).toBe("12:05 AM");
  });
});

describe("lib/timefmt formatDate", () => {
  it("drops the year this year and keeps it otherwise", () => {
    expect(formatDate(new Date(2026, 9, 7), { now })).toBe("7 Oct");
    expect(formatDate(new Date(2025, 9, 7), { now })).toBe("7 Oct 2025");
    expect(formatDate(new Date(2027, 0, 1), { now })).toBe("1 Jan 2027");
  });

  it("always shows the year when asked (print)", () => {
    expect(formatDate(new Date(2026, 9, 7), { now, year: true })).toBe("7 Oct 2026");
  });

  it("reads date-only strings in UTC so the day doesn't slip a zone", () => {
    expect(formatDate("2026-10-07", { now, utc: true })).toBe("7 Oct");
    expect(formatDate("2025-12-31", { now, utc: true })).toBe("31 Dec 2025");
    expect(formatDate("2026-11-01T00:00:00.000Z", { now, utc: true })).toBe("1 Nov");
  });
});

describe("lib/timefmt formatMonth", () => {
  it("names the month and the full year, never May 24", () => {
    expect(formatMonth(new Date(2024, 4, 24))).toBe("May 2024");
    expect(formatMonth(new Date(2026, 0, 1))).toBe("Jan 2026");
  });
});
