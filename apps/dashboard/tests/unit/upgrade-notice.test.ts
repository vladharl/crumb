import { describe, it, expect, vi } from "vitest";
import type { Feature } from "@/lib/entitlements";

// The notice only reads the session when no role is passed; these tests pass it.
vi.mock("@/lib/server", () => ({ getActiveSession: vi.fn() }));

import { usagePercent, usageResetsAt } from "@/lib/usage";
import { aiUsageCopy, upgradeNoticeCopy } from "@/components/UpgradeNotice";

describe("AI usage read helpers", () => {
  it("floors the percent so 80% never shows early, and tops out at 100", () => {
    expect(usagePercent(1_599, 2_000)).toBe(79);
    expect(usagePercent(1_600, 2_000)).toBe(80);
    expect(usagePercent(1_999, 2_000)).toBe(99);
    expect(usagePercent(2_000, 2_000)).toBe(100);
    expect(usagePercent(2_400, 2_000)).toBe(100); // cap lowered mid-month
    expect(usagePercent(0, 0)).toBe(100);
  });

  it("resets on the first of next UTC month, across the year end", () => {
    expect(usageResetsAt(new Date("2026-10-07T15:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(usageResetsAt(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("upgrade notice by role", () => {
  it("names the unlocking plan; admins get See plans with it preselected", () => {
    expect(upgradeNoticeCopy("ai", true)).toEqual({
      text: "The Team plan adds the AI suite: clustering, Ask, ticket and reply drafts.",
      hint: null,
      href: "/settings/billing?plan=team",
    });
    expect(upgradeNoticeCopy("session_record", true).href).toBe("/settings/billing?plan=growth");
  });

  it("points everyone else at an admin, with no billing link", () => {
    expect(upgradeNoticeCopy("integrations", false)).toEqual({
      text: "The Team plan adds one-click Slack, Linear, Jira and GitHub, plus CRM sync and feedback connectors.",
      hint: "Ask an admin to upgrade.",
      href: null,
    });
  });

  it("never uses an em-dash", () => {
    const features: Feature[] = ["ai", "integrations", "session_record", "usage_analytics"];
    for (const f of features) for (const admin of [true, false]) {
      expect(upgradeNoticeCopy(f, admin).text).not.toContain("—");
    }
  });
});

describe("AI usage notice", () => {
  const resets = new Date("2026-11-01T00:00:00Z");

  it("stays quiet under 80%", () => {
    expect(aiUsageCopy(79, resets, true, "team")).toBeNull();
  });

  it("warns from 80% and pauses at 100%, with the reset date", () => {
    expect(aiUsageCopy(85, resets, false, "team")?.text).toBe("You've used 85% of this month's AI operations. Resets Nov 1.");
    expect(aiUsageCopy(100, resets, false, "team")?.text).toBe("AI is paused until Nov 1.");
  });

  it("gives Team admins the upgrade path, and nobody else", () => {
    expect(aiUsageCopy(100, resets, true, "team")?.href).toBe("/settings/billing");
    expect(aiUsageCopy(85, resets, true, "team")?.href).toBe("/settings/billing");
    expect(aiUsageCopy(100, resets, false, "team")?.href).toBeNull();
    // Growth is the top plan: no plan to buy, so no link.
    expect(aiUsageCopy(100, resets, true, "growth")?.href).toBeNull();
  });
});
