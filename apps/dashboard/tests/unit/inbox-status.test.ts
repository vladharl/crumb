import { describe, it, expect, vi } from "vitest";
import { statusLabel } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { emailNote, statusToast } from "@/app/(app)/inbox/RowActionMenu";

// RowActionMenu.tsx is a client component that also imports the inbox server
// actions; stub those so its status helpers load under node.
vi.mock("@/app/(app)/inbox/actions", () => ({}));
vi.mock("@/app/(app)/initiatives/actions", () => ({}));

describe("inbox status writes", () => {
  it("toasts what the write actually did", () => {
    expect(statusToast({ ok: true, affected: 3, failed: 0 }, "Shipped")).toEqual({ message: "3 items moved to Shipped." });
    expect(statusToast({ ok: true, affected: 1, failed: 0 }, "Shipped")).toEqual({ message: "1 item moved to Shipped." });
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

  it("says plainly who gets emailed, without em or en dashes", () => {
    expect(emailNote(1, true)).toMatch(/^The submitter gets an email/);
    expect(emailNote(4, true)).toMatch(/^Submitters get an email/);
    for (const note of [emailNote(1, true), emailNote(4, true)]) {
      expect(note).toMatch(/opted out/);
      expect(note).toMatch(/widget/);
      expect(note).not.toMatch(/[–—]/);
    }
  });

  it("promises no email when no email provider is set up", () => {
    expect(emailNote(1, false)).toBe("Email delivery isn't set up yet, so nobody gets emailed.");
    expect(emailNote(4, false)).toBe(emailNote(1, false));
  });
});
