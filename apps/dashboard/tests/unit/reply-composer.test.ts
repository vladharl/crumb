import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VENDOR_STATUSES } from "@crumb/ui";
import type { NotifyPlan, NotifySkipReason } from "@/lib/notify/customer-plan";

// The composer imports the thread's server actions (db, session); the copy and
// timing helpers under test never call them.
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({}));

import {
  firstName, noEmailNote, replyNote, replySentMessage, sendAfterDelay, statusMovedMessage, statusWillEmail,
} from "@/components/ReplyComposer";

const emails: NotifyPlan = { willEmail: true };
const skip = (reason: NotifySkipReason): NotifyPlan => ({ willEmail: false, reason });
const REASONS: NotifySkipReason[] = ["source", "no_email", "unsubscribed", "muted", "not_configured"];

describe("composer copy: what the customer actually gets", () => {
  it("addresses the submitter by first name", () => {
    expect(firstName("Maya Lopez")).toBe("Maya");
    expect(firstName("  Ana ")).toBe("Ana");
    expect(firstName("  ")).toBe("the customer");
  });

  it("says 'by email' only when the plan emails", () => {
    expect(replyNote(emails, "Maya", "Acme", null)).toBe("Replying to Maya at Acme. They'll get this by email.");
    for (const r of REASONS) {
      const note = replyNote(skip(r), "Maya", "Acme", "zendesk");
      expect(note).not.toContain("by email");
      expect(note).toMatch(/won't be emailed|nothing gets emailed/);
    }
    expect(noEmailNote(emails, "status", "Maya", null)).toBeNull();
  });

  it("names the channel a pulled item came in through, and which emails a mute turned off", () => {
    expect(noEmailNote(skip("source"), "reply", "Maya", "zendesk"))
      .toBe("This came in through Zendesk, so Maya won't be emailed. Follow up there too.");
    expect(noEmailNote(skip("not_configured"), "reply", "Maya", null))
      .toBe("Email delivery isn't set up yet, so Maya won't be emailed.");
    expect(noEmailNote(skip("muted"), "reply", "Maya", null)).toContain("turned off reply emails");
    expect(noEmailNote(skip("muted"), "status", "Maya", null)).toContain("turned off status emails");
  });

  it("toasts the emailed flag, never a blanket 'notified'", () => {
    expect(replySentMessage(true, "Maya")).toBe("Reply sent to Maya by email.");
    expect(replySentMessage(false, "Maya")).toBe("Reply posted. Maya wasn't emailed.");
    expect(replySentMessage(true, "Maya", "shipped")).toBe("Reply sent to Maya by email, and marked Shipped.");
    expect(replySentMessage(false, "Maya", "declined")).toBe("Reply posted and marked Won’t ship. Maya wasn't emailed.");
    expect(statusMovedMessage("shipped", "Maya", true)).toBe("Marked Shipped. Maya was emailed.");
    expect(statusMovedMessage("shipped", "Maya", false)).toBe("Marked Shipped. Maya wasn't emailed.");
    // Triage moves never email, so their toast doesn't mention it.
    expect(statusMovedMessage("review", "Maya", false)).toBe("Marked In review.");
  });

  it("never uses an em or en dash", () => {
    const copy = [
      ...REASONS.flatMap(r => [noEmailNote(skip(r), "reply", "Maya", "gong"), noEmailNote(skip(r), "status", "Maya", null)]),
      replyNote(emails, "Maya", "Acme", null),
      replySentMessage(true, "Maya", "declined"), replySentMessage(false, "Maya"),
      ...VENDOR_STATUSES.flatMap(s => [statusMovedMessage(s, "Maya", true), statusMovedMessage(s, "Maya", false)]),
    ];
    for (const s of copy) expect(s).not.toMatch(/[—–]/);
  });
});

describe("statusWillEmail (which status rows say they email)", () => {
  it("matches the server's outcome set when the plan emails", () => {
    expect(VENDOR_STATUSES.filter(s => statusWillEmail(s, "open", emails)))
      .toEqual(["planned", "progress", "shipped", "declined", "deferred"]);
  });

  it("is false for the current status and whenever the plan won't email", () => {
    expect(statusWillEmail("shipped", "shipped", emails)).toBe(false);
    for (const r of REASONS) expect(statusWillEmail("shipped", "open", skip(r))).toBe(false);
  });
});

describe("sendAfterDelay (status-email undo)", () => {
  let guards: Set<(e: { preventDefault: () => void; returnValue?: unknown }) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    guards = new Set();
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: never) => { if (type === "beforeunload") guards.add(fn); },
      removeEventListener: (type: string, fn: never) => { if (type === "beforeunload") guards.delete(fn); },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends once the delay ends, and asks before leaving the page until then", () => {
    const send = vi.fn();
    const pending = sendAfterDelay(send, 6000);
    expect(guards.size).toBe(1);
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    [...guards][0]!(e);
    expect(e.preventDefault).toHaveBeenCalled();

    vi.advanceTimersByTime(5999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(guards.size).toBe(0);
    expect(pending.undo()).toBe(false); // too late: it already went
  });

  it("an undo in time sends nothing", () => {
    const send = vi.fn();
    const pending = sendAfterDelay(send, 6000);
    vi.advanceTimersByTime(3000);
    expect(pending.undo()).toBe(true);
    expect(pending.undo()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(guards.size).toBe(0);
  });
});
