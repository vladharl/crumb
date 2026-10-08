import { describe, expect, it, vi } from "vitest";
import type { NotifyPlan } from "@/lib/notify/customer-plan";

// The thread's composer keys, AI draft insert and timeout, reply-and-close
// copy, merge confirm and who the Trail credits. Pure helpers only; the server
// actions never load.
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({}));
vi.mock("@/app/(app)/initiatives/actions", () => ({}));
vi.mock("@/app/(app)/items/delete-actions", () => ({}));

import { closeConfirmBody, isSendShortcut, replySentMessage, settle, withAiDraft } from "@/components/ReplyComposer";
import { mergeConfirmBody, unmergedMessage } from "@/app/(app)/thread/[shortId]/MergePanel";
import { trailActor } from "@/app/(app)/thread/[shortId]/ThreadView";

const emails: NotifyPlan = { willEmail: true };
const source: NotifyPlan = { willEmail: false, reason: "source" };
const key = (over: Partial<Parameters<typeof isSendShortcut>[0]> = {}) => ({
  key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, keyCode: 13,
  nativeEvent: { isComposing: false }, ...over,
});

describe("Cmd/Ctrl+Enter sends", () => {
  it("fires on Cmd+Enter and Ctrl+Enter only", () => {
    expect(isSendShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSendShortcut(key())).toBe(false); // a plain Enter is a new line
    expect(isSendShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSendShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSendShortcut(key({ key: "a", metaKey: true }))).toBe(false);
  });

  it("never fires while an IME composition is committing", () => {
    expect(isSendShortcut(key({ metaKey: true, nativeEvent: { isComposing: true } }))).toBe(false);
    // Safari: the committing keydown says isComposing false but keyCode 229.
    expect(isSendShortcut(key({ metaKey: true, keyCode: 229 }))).toBe(false);
  });
});

describe("AI draft goes below what's written", () => {
  it("fills an empty box and keeps typed text above the draft", () => {
    expect(withAiDraft("", "Thanks for flagging this.")).toBe("Thanks for flagging this.");
    expect(withAiDraft("  \n", "Thanks.")).toBe("Thanks.");
    expect(withAiDraft("Hi Maya,\n", "Thanks.")).toBe("Hi Maya,\n\nThanks.");
  });
});

describe("reply-and-close says who gets what", () => {
  const plan = { replies: emails, status: emails };

  it("names the merged requesters in the confirm and the toast, without the reply", () => {
    expect(closeConfirmBody("shipped", "Maya", plan, null, 2)).toBe(
      "Maya gets one email with your reply, and this is marked Shipped. 2 others who asked get the Shipped email, without your reply.",
    );
    expect(closeConfirmBody("declined", "Maya", plan, null, 1)).toBe(
      "Maya gets one email with your reply as the reason, and this is marked Won’t ship. 1 other who asked gets the Won’t ship email, without your reply.",
    );
    expect(replySentMessage(true, "Maya", "shipped", 2)).toBe(
      "Reply sent to Maya by email, and marked Shipped. 2 others who asked also got the Shipped email, without your reply.",
    );
    expect(replySentMessage(false, "Maya", "declined", 0)).toBe("Reply posted and marked Won’t ship. Maya wasn't emailed.");
  });

  it("says why the submitter isn't emailed when only the merged requesters are", () => {
    expect(closeConfirmBody("shipped", "Maya", { replies: source, status: source }, "zendesk", 1)).toBe(
      "This came in through Zendesk, so Maya won't be emailed. Follow up there too. 1 other who asked gets the Shipped email, without your reply.",
    );
  });
});

describe("merge confirm spells out the direction", () => {
  const notice = { name: "Maya Lopez", accountName: "Globex", source: "widget", plan: emails };

  it("says which way it folds, who follows what, and the one email", () => {
    expect(mergeConfirmBody("FB-12", "FB-9", notice)).toBe(
      "FB-12 folds into FB-9. FB-12's customer follows FB-9 from now on. Maya at Globex will get one email that this was combined.",
    );
    expect(mergeConfirmBody("FB-12", "FB-9", { ...notice, plan: { willEmail: false, reason: "unsubscribed" }, carried: 3 })).toBe(
      "FB-12 folds into FB-9. FB-12's customer follows FB-9 from now on. So do the 3 requests already merged into FB-12. "
      + "Maya unsubscribed from email, so nothing gets emailed.",
    );
    expect(unmergedMessage("FB-12", "planned", 1)).toBe(
      "FB-12 stands on its own again, back to Planned. The 1 request merged into it came back too.",
    );
  });

  it("never uses an em or en dash", () => {
    const copy = [
      mergeConfirmBody("FB-1", "FB-2", { ...notice, carried: 1 }), unmergedMessage("FB-1", "open", 0),
      closeConfirmBody("declined", "Maya", { replies: emails, status: emails }, null, 2), replySentMessage(true, "Maya", "shipped", 1),
    ];
    for (const s of copy) expect(s).not.toMatch(/[—–]/);
  });
});

describe("an AI draft never waits forever", () => {
  it("gives the call's result, a timeout failure once the wait is up, or failed on a throw", async () => {
    expect(await settle(Promise.resolve({ ok: true, draft: "Hi" }), 1000, "draft_timeout")).toEqual({ ok: true, draft: "Hi" });
    expect(await settle(Promise.reject(new Error("down")), 1000, "draft_timeout")).toEqual({ ok: false, error: "failed" });
    vi.useFakeTimers();
    try {
      const slow = settle(new Promise(() => {}), 90_000, "draft_timeout");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await slow).toEqual({ ok: false, error: "draft_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Trail credits the customer for their own moves", () => {
  const opened = { byName: null, fromStatus: null, toStatus: "open" };

  it("names the submitter for a widget or legacy submission and their own close, System otherwise", () => {
    expect(trailActor(opened, "Maya", "widget")).toBe("Maya");
    expect(trailActor(opened, "Maya", null)).toBe("Maya");
    expect(trailActor({ byName: null, fromStatus: "planned", toStatus: "resolved" }, "Maya", "zendesk")).toBe("Maya");
    expect(trailActor(opened, "Maya", "zendesk")).toBe("System"); // Autopilot pulled it in
    expect(trailActor({ byName: null, fromStatus: "progress", toStatus: "shipped" }, "Maya", "widget")).toBe("System");
    expect(trailActor({ ...opened, byName: "Lina Rivers" }, "Maya", "widget")).toBe("Lina Rivers");
  });
});
