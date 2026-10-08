import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VENDOR_STATUSES } from "@crumb/ui";
import type { NotifyPlan, NotifySkipReason } from "@/lib/notify/customer-plan";

// useStatusMove runs under a one-render stand-in for React: state keeps its
// first value, refs are plain objects, and effects are collected so a test can
// mount and unmount them. The thread's server actions, router, toast and
// confirm are fakes; only updateStatus is ever called.
const h = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  updateStatus: vi.fn(async (_input: { itemShortId: string; status: string; reason?: string }) => ({ ok: true, emailed: true })),
  toast: { show: vi.fn((_opts: { message: string; action?: { onClick: () => void } }) => 7), dismiss: vi.fn((_id: number) => {}) },
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => [typeof init === "function" ? init() : init, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: (fn: () => unknown) => { h.effects.push(fn); },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => h.toast }));
vi.mock("@/components/confirm", () => ({ useConfirm: () => async () => true }));
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({ updateStatus: h.updateStatus }));

import {
  STATUS_EMAIL_DELAY_MS, cancelWaitingMove, firstName, modeForTabChange, noEmailNote, replyNote, replySentMessage,
  sendAfterDelay, statusEmailees, statusMovedMessage, statusWillEmail, useStatusMove,
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
    // An AI assistant logged it: named in words, with nowhere to follow up.
    expect(noEmailNote(skip("source"), "status", "Ann", "mcp"))
      .toBe("This came in through an AI assistant (MCP), so Ann won't be emailed.");
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
    // The customers whose requests were merged in get the outcome too.
    expect(statusMovedMessage("shipped", "Maya", true, 2)).toBe("Marked Shipped. Maya and 2 others who asked were emailed.");
    expect(statusMovedMessage("shipped", "Maya", false, 1)).toBe("Marked Shipped. 1 other who asked was emailed. Maya wasn't.");
  });

  it("names everyone a status email reaches", () => {
    expect(statusEmailees("Maya", true, 0)).toBe("Maya");
    expect(statusEmailees("Maya", true, 2)).toBe("Maya and 2 others who asked");
    expect(statusEmailees("Maya", false, 1)).toBe("1 other who asked");
  });

  it("never uses an em or en dash", () => {
    const copy = [
      ...REASONS.flatMap(r => [noEmailNote(skip(r), "reply", "Maya", "gong"), noEmailNote(skip(r), "status", "Maya", null)]),
      replyNote(emails, "Maya", "Acme", null),
      replySentMessage(true, "Maya", "declined"), replySentMessage(false, "Maya"),
      ...VENDOR_STATUSES.flatMap(s => [statusMovedMessage(s, "Maya", true), statusMovedMessage(s, "Maya", false)]),
      statusMovedMessage("shipped", "Maya", true, 3), statusMovedMessage("shipped", "Maya", false, 1),
      noEmailNote(skip("source"), "status", "Maya", "mcp"),
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

  it("is true when only merged requesters get the email, for outcomes only", () => {
    expect(statusWillEmail("declined", "open", skip("source"), 2)).toBe(true);
    expect(statusWillEmail("review", "open", skip("source"), 2)).toBe(false);
  });
});

describe("modeForTabChange (the composer follows the conversation's tab)", () => {
  it("picks a note on Internal and a reply on Customer, only when the tab changes", () => {
    expect(modeForTabChange("reply", "note", true)).toBe("note");
    expect(modeForTabChange("note", "reply", true)).toBe("reply");
    // No change (or the Trail, which has no composer): a hand-flipped switch stays.
    expect(modeForTabChange("note", "note", true)).toBeNull();
    expect(modeForTabChange("reply", undefined, true)).toBeNull();
  });

  it("keeps viewers on notes", () => {
    expect(modeForTabChange("note", "reply", false)).toBe("note");
  });
});

// A window/document stand-in that records listeners and can fire them.
function eventTarget() {
  const on = new Map<string, Set<() => void>>();
  return {
    visibilityState: "visible",
    addEventListener: (type: string, fn: () => void) => { on.set(type, (on.get(type) ?? new Set()).add(fn)); },
    removeEventListener: (type: string, fn: () => void) => { on.get(type)?.delete(fn); },
    fire: (type: string) => { for (const fn of [...(on.get(type) ?? [])]) fn(); },
    listening: () => [...on.values()].reduce((n, fns) => n + fns.size, 0),
  };
}

describe("sendAfterDelay (status-email undo)", () => {
  let win: ReturnType<typeof eventTarget>;
  let doc: ReturnType<typeof eventTarget>;

  beforeEach(() => {
    vi.useFakeTimers();
    win = eventTarget();
    doc = eventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends once the delay ends, then stops listening", () => {
    const send = vi.fn();
    const pending = sendAfterDelay(send, 6000);
    expect(win.listening() + doc.listening()).toBe(2);

    vi.advanceTimersByTime(5999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(win.listening() + doc.listening()).toBe(0);
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
    expect(win.listening() + doc.listening()).toBe(0);
  });

  it("sends at once, and only once, when the page is hidden or left", () => {
    const hidden = vi.fn();
    sendAfterDelay(hidden, 6000);
    doc.fire("visibilitychange"); // still visible: keeps waiting
    expect(hidden).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(hidden).toHaveBeenCalledTimes(1);

    const left = vi.fn();
    const pending = sendAfterDelay(left, 6000);
    win.fire("pagehide");
    expect(left).toHaveBeenCalledTimes(1);
    pending.flush();
    vi.advanceTimersByTime(60_000);
    expect(left).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(pending.undo()).toBe(false);
  });
});

describe("useStatusMove (an emailing move waits behind Undo)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", eventTarget());
    vi.stubGlobal("document", eventTarget());
    h.effects.length = 0;
    h.updateStatus.mockClear();
    h.toast.show.mockClear();
    h.toast.dismiss.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Renders the hook for FB-1 (open, its submitter gets status emails) and
  // runs its effects, as mounting would.
  function mount() {
    const { move } = useStatusMove({ itemShortId: "FB-1", status: "open", first: "Maya", source: null, plan: emails });
    const cleanups = h.effects.map(effect => effect());
    return { move, unmount: () => { for (const c of cleanups) if (typeof c === "function") c(); } };
  }
  const committed = { itemShortId: "FB-1", status: "planned", reason: undefined };

  it("commits once the undo window ends", async () => {
    const m = mount();
    await m.move("planned");
    expect(h.updateStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STATUS_EMAIL_DELAY_MS);
    expect(h.updateStatus).toHaveBeenCalledWith(committed);
    m.unmount();
    expect(h.updateStatus).toHaveBeenCalledTimes(1);
  });

  it("Undo inside the window sends nothing", async () => {
    const m = mount();
    await m.move("planned");
    h.toast.show.mock.calls[0]![0].action!.onClick();
    vi.advanceTimersByTime(60_000);
    m.unmount();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it("commits at once when the composer's page unmounts, and ends the Undo", async () => {
    const m = mount();
    await m.move("planned");
    m.unmount();
    expect(h.updateStatus).toHaveBeenCalledWith(committed);
    expect(h.toast.dismiss).toHaveBeenCalledWith(7);
    vi.advanceTimersByTime(60_000);
    expect(h.updateStatus).toHaveBeenCalledTimes(1);
  });

  it("waits behind Undo when only the merged requesters will be emailed", async () => {
    const { move } = useStatusMove({
      itemShortId: "FB-2", status: "open", first: "Maya", source: "zendesk", plan: skip("source"), mergedReach: 2,
    });
    await move("declined", "Not this year.");
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.toast.show.mock.calls[0]![0].message).toBe("Marked Won’t ship. Emailing 2 others who asked in 6 seconds.");
    vi.advanceTimersByTime(STATUS_EMAIL_DELAY_MS);
    expect(h.updateStatus).toHaveBeenCalledWith({ itemShortId: "FB-2", status: "declined", reason: "Not this year." });
  });

  it("never commits once another status change for the item has started", async () => {
    const m = mount();
    await m.move("planned");
    cancelWaitingMove("FB-1");
    expect(h.toast.dismiss).toHaveBeenCalledWith(7);
    vi.advanceTimersByTime(60_000);
    m.unmount();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });
});
