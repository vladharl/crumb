import { describe, it, expect } from "vitest";
import { autoNotifiesSubmitter, isPulledConnectorSource } from "@/lib/feedback/source";

describe("autoNotifiesSubmitter — widget-only auto-notification", () => {
  it("notifies widget-origin submitters", () => {
    expect(autoNotifiesSubmitter("widget")).toBe(true);
  });

  it("notifies legacy/native items with no explicit source (NULL)", () => {
    expect(autoNotifiesSubmitter(null)).toBe(true);
    expect(autoNotifiesSubmitter(undefined)).toBe(true);
  });

  it("never auto-notifies customers pulled from connectors", () => {
    for (const s of ["gong", "zendesk", "intercom", "freshdesk", "freshchat"]) {
      expect(autoNotifiesSubmitter(s)).toBe(false);
    }
  });

  it("never auto-notifies forwarded email/slack/extension captures", () => {
    expect(autoNotifiesSubmitter("email")).toBe(false);
    expect(autoNotifiesSubmitter("slack")).toBe(false);
    expect(autoNotifiesSubmitter("extension")).toBe(false);
  });
});

describe("isPulledConnectorSource", () => {
  it("flags only the five pull connectors", () => {
    expect(isPulledConnectorSource("gong")).toBe(true);
    expect(isPulledConnectorSource("zendesk")).toBe(true);
    expect(isPulledConnectorSource("widget")).toBe(false);
    expect(isPulledConnectorSource("email")).toBe(false);
    expect(isPulledConnectorSource(null)).toBe(false);
  });
});
