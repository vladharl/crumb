import { describe, it, expect, beforeEach } from "vitest";
import { slackBlocksFor, teamsCardFor, type ChatEvent } from "@/lib/notify/chat";
import { assertSafeWebhookUrl } from "@/lib/notify/url-guard";

const ev: ChatEvent = {
  kind: "status_change", shortId: "FB-1", title: "Export breaks",
  fromStatus: "open", toStatus: "shipped", reason: "fixed in v2", url: "https://x.test/t",
};

describe("chat card builders", () => {
  it("slack blocks carry the headline + an Open button when url present", () => {
    const m = slackBlocksFor(ev);
    expect(m.text).toContain("FB-1");
    expect(JSON.stringify(m.blocks)).toContain("https://x.test/t");
  });

  it("teams card is an Adaptive Card v1.4", () => {
    const c = teamsCardFor(ev) as { type: string; version: string };
    expect(c.type).toBe("AdaptiveCard");
    expect(c.version).toBe("1.4");
  });
});

describe("assertSafeWebhookUrl", () => {
  beforeEach(() => {
    delete process.env.CRUMB_WEBHOOK_ALLOW_ANY;
  });

  it("blocks http, private ranges, and disallowed hosts", () => {
    expect(assertSafeWebhookUrl("http://hooks.slack.com/x").ok).toBe(false);
    expect(assertSafeWebhookUrl("https://127.0.0.1/x").ok).toBe(false);
    expect(assertSafeWebhookUrl("https://169.254.169.254/latest").ok).toBe(false);
    expect(assertSafeWebhookUrl("https://evil.example.com/x").ok).toBe(false);
  });

  it("allows the known SaaS hosts", () => {
    expect(assertSafeWebhookUrl("https://hooks.slack.com/services/x").ok).toBe(true);
    expect(assertSafeWebhookUrl("https://acme.webhook.office.com/x").ok).toBe(true);
    expect(assertSafeWebhookUrl("https://prod-1.westus.logic.azure.com/x").ok).toBe(true);
  });

  it("allows anything under the escape hatch", () => {
    process.env.CRUMB_WEBHOOK_ALLOW_ANY = "1";
    expect(assertSafeWebhookUrl("http://localhost:3940/slack").ok).toBe(true);
  });
});
