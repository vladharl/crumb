import { describe, it, expect, vi } from "vitest";
import { VENDOR_STATUSES } from "@crumb/ui";
import { customerNotifyPlan, statusEmailsCustomer } from "@/lib/notify/customer-plan";

const base = {
  source: "widget",
  submitterEmail: "ana@acme.co",
  unsubscribedAll: false,
  notifyReplies: true,
  notifyStatus: true,
  emailConfigured: true,
};

describe("customerNotifyPlan", () => {
  it("emails a widget submitter with a real address and both prefs on", () => {
    expect(customerNotifyPlan(base)).toEqual({ replies: { willEmail: true }, status: { willEmail: true } });
  });

  it("treats legacy items with no source as widget-origin", () => {
    expect(customerNotifyPlan({ ...base, source: null }).status).toEqual({ willEmail: true });
  });

  it("never emails customers pulled from connectors or forwarded captures", () => {
    for (const source of ["zendesk", "gong", "email", "slack"]) {
      expect(customerNotifyPlan({ ...base, source })).toEqual({
        replies: { willEmail: false, reason: "source" },
        status: { willEmail: false, reason: "source" },
      });
    }
  });

  it("skips missing and placeholder (.invalid) addresses", () => {
    for (const submitterEmail of [null, "", "  ", "slack-U1@slack.invalid", "X@SLACK.INVALID "]) {
      expect(customerNotifyPlan({ ...base, submitterEmail }).replies).toEqual({ willEmail: false, reason: "no_email" });
    }
  });

  it("lets the master unsubscribe win over the per-kind prefs", () => {
    expect(customerNotifyPlan({ ...base, unsubscribedAll: true })).toEqual({
      replies: { willEmail: false, reason: "unsubscribed" },
      status: { willEmail: false, reason: "unsubscribed" },
    });
  });

  it("mutes replies and status updates independently", () => {
    expect(customerNotifyPlan({ ...base, notifyStatus: false })).toEqual({
      replies: { willEmail: true },
      status: { willEmail: false, reason: "muted" },
    });
    expect(customerNotifyPlan({ ...base, notifyReplies: false })).toEqual({
      replies: { willEmail: false, reason: "muted" },
      status: { willEmail: true },
    });
  });

  it("reports not_configured only when nothing on the customer side is in the way", () => {
    const off = { ...base, emailConfigured: false };
    expect(customerNotifyPlan(off).status).toEqual({ willEmail: false, reason: "not_configured" });
    expect(customerNotifyPlan({ ...off, source: "zendesk" }).status).toEqual({ willEmail: false, reason: "source" });
    expect(customerNotifyPlan({ ...off, notifyStatus: false }).status).toEqual({ willEmail: false, reason: "muted" });
  });
});

describe("statusEmailsCustomer", () => {
  it("emails for commitments and outcomes, not triage moves or duplicates", () => {
    expect(VENDOR_STATUSES.filter(statusEmailsCustomer)).toEqual(["planned", "progress", "shipped", "declined", "deferred"]);
  });

  it("stays quiet for the customer's own close and unknown values", () => {
    expect(statusEmailsCustomer("resolved")).toBe(false);
    expect(statusEmailsCustomer("bogus")).toBe(false);
  });
});

describe("stdout email provider", () => {
  it("prints customer emails but never reports them delivered (no ledger row)", async () => {
    delete process.env.CRUMB_EMAIL_PROVIDER;
    const { emailConfigured, sendReplyNotification, sendStatusChangeNotification } = await import("@/lib/email");
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const common = { to: "ana@acme.co", workspaceName: "Acme", vendorName: "Lina", itemShortId: "FB-1", itemTitle: "Export" };

    expect(emailConfigured()).toBe(false);
    expect(await sendReplyNotification({ ...common, replyBody: "On it." })).toBe(false);
    expect(await sendStatusChangeNotification({ ...common, fromStatus: "open", toStatus: "shipped" })).toBe(false);
    expect(print).toHaveBeenCalledTimes(2);
    print.mockRestore();
  });
});
