import { describe, it, expect, vi } from "vitest";
import { statusLabel } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { emailNote, emailReach, mayEmail, statusToast } from "@/app/(app)/inbox/RowActionMenu";

// RowActionMenu.tsx is a client component that also imports the inbox server
// actions (and, through the composer, the thread's); stub those so its status
// helpers load under node.
vi.mock("@/app/(app)/inbox/actions", () => ({}));
vi.mock("@/app/(app)/initiatives/actions", () => ({}));
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({}));

describe("inbox status writes", () => {
  it("toasts what the write actually did", () => {
    expect(statusToast({ ok: true, affected: 3, failed: 0 }, "Shipped")).toEqual({ message: "3 requests moved to Shipped." });
    expect(statusToast({ ok: true, affected: 1, failed: 0 }, "Shipped")).toEqual({ message: "1 request moved to Shipped." });
    expect(statusToast({ ok: true, affected: 1, failed: 0 }, statusLabel("declined"), "FB-12"))
      .toEqual({ message: "FB-12 moved to Won’t ship." });

    // Some moved: counts first, then why the rest didn't.
    expect(statusToast({ ok: true, affected: 2, failed: 1, firstError: "not_found" }, "Shipped"))
      .toEqual({ message: `2 moved, 1 failed. ${errorMessage("not_found")}`, tone: "error" });
    // Nothing moved (a single row, or a whole batch): just the reason.
    expect(statusToast({ ok: true, affected: 0, failed: 1, firstError: "not_found" }, "Shipped", "FB-12"))
      .toEqual({ message: errorMessage("not_found"), tone: "error" });
    expect(statusToast({ ok: true, affected: 0, failed: 2 }, "Shipped"))
      .toEqual({ message: errorMessage(undefined), tone: "error" });
    expect(statusToast({ ok: false, error: "reason_required" }, "Set aside"))
      .toEqual({ message: errorMessage("reason_required"), tone: "error" });
  });

  it("names the merged duplicates a bulk move left to the request they were merged into", () => {
    expect(statusToast({ ok: true, affected: 3, failed: 0, skipped: 1 }, "Shipped"))
      .toEqual({ message: "3 requests moved to Shipped. Skipped 1 merged duplicate. It follows the request it was merged into." });
    expect(statusToast({ ok: true, affected: 2, failed: 1, firstError: "not_found", skipped: 2 }, "Shipped").message)
      .toMatch(/Skipped 2 merged duplicates\. They follow the requests they were merged into\.$/);
    expect(statusToast({ ok: true, affected: 0, failed: 0, skipped: 2 }, "Shipped"))
      .toEqual({ message: "Nothing moved. Merged duplicates follow the request they were merged into." });
    expect(statusToast({ ok: true, affected: 0, failed: 0, skipped: 1 }, "Shipped", "FB-12"))
      .toEqual({ message: "FB-12 is merged into another request, so it follows that request's status." });
  });

  const widget = emailReach([{ source: null, mergedCount: 0 }]);
  const mergedIntoGong = emailReach([{ source: "gong", mergedCount: 2 }]);
  const mergedIntoWidget = emailReach([{ source: "widget", mergedCount: 1 }]);

  it("says plainly who gets emailed, without em or en dashes", () => {
    // One row's source is known: it came in through the widget.
    expect(emailNote(1, true, widget)).toBe("The submitter gets an email about this, unless they opted out.");
    // A selection can mix sources.
    expect(emailNote(4, true, widget)).toBe(
      "Submitters get an email about this, unless they opted out or their request didn't come in through the widget.",
    );
    // The customers merged in get the status, never the reason.
    expect(emailNote(1, true, mergedIntoWidget, true)).toBe(
      "The submitter gets an email about this, unless they opted out. The email includes your reason. "
      + "Customers whose requests were merged into it may get the status email too, without your reason.",
    );
    expect(emailNote(3, true, mergedIntoGong)).toBe("Customers whose requests were merged into them may get the status email.");
    for (const reach of [widget, mergedIntoGong, mergedIntoWidget]) {
      for (const note of [emailNote(1, true, reach), emailNote(4, true, reach, true)]) expect(note).not.toMatch(/[–—]/);
    }
  });

  it("asks first only where an outcome can email someone", () => {
    // Connector, capture, Slack and MCP requests never email their submitter.
    for (const source of ["zendesk", "gong", "email", "extension", "slack", "mcp"]) {
      expect(mayEmail("shipped", emailReach([{ source, mergedCount: 0 }]))).toBe(false);
    }
    expect(mayEmail("shipped", emailReach([{ source: "widget", mergedCount: 0 }]))).toBe(true);
    expect(mayEmail("shipped", widget)).toBe(true); // a legacy item, source unset
    expect(mayEmail("review", widget)).toBe(false); // triage moves never email
    // Widget customers merged into one can still hear about it.
    expect(mayEmail("declined", mergedIntoGong)).toBe(true);
    // Nothing that moves (only merged duplicates selected): nobody to ask about.
    expect(mayEmail("shipped", emailReach([]))).toBe(false);
  });

  it("promises no email when no email provider is set up", () => {
    expect(emailNote(1, false, widget)).toBe("Email delivery isn't set up yet, so nobody gets emailed.");
    expect(emailNote(4, false, mergedIntoGong, true)).toBe(emailNote(1, false, widget));
  });
});
