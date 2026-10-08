import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@crumb/db";
import { errorMessage } from "@/lib/action-error";

// A bulk status change runs each item's whole pipeline (customer email
// included) inside one server action, so a request is capped and runs a few
// items at a time. Merged duplicates are left to the item they were merged
// into (which emails their customers), and a customer with several requests in
// the batch hears about each one. The session, request and status core are faked.

const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server", () => ({
  getActiveSession: async () => ({ workspace: { id: "ws-1" }, user: { id: "user-1", role: "admin" } }),
}));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/items/mutations", () => ({ updateItemStatus: update }));

import { bulkUpdateStatus } from "@/app/(app)/inbox/actions";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `item-${i}`);

type Found = { id: string; shortId: string; status: string; mergedIntoId: string | null };

// The workspace-scoped lookup finds every requested item (FB-1, FB-2, …).
function found(itemIds: string[], over: Array<Partial<Found>> = []) {
  vi.spyOn(db, "select").mockReturnValue({
    from: () => ({
      where: async () => itemIds.map((id, i): Found => ({ id, shortId: `FB-${i + 1}`, status: "open", mergedIntoId: null, ...over[i] })),
    }),
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  update.mockReset();
});

describe("bulkUpdateStatus", () => {
  it("refuses more than 50 items in one request, with an error people can act on", async () => {
    found(ids(51));
    expect(await bulkUpdateStatus(ids(51), "planned")).toEqual({ ok: false, error: "too_many_items" });
    expect(update).not.toHaveBeenCalled();
    expect(errorMessage("too_many_items")).toBe("Select up to 50 at a time.");
  });

  it("runs every item, at most 4 at a time", async () => {
    found(ids(50));
    let inFlight = 0;
    let peak = 0;
    update.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      inFlight--;
      return { ok: true, emailed: false };
    });
    expect(await bulkUpdateStatus(ids(50), "planned")).toEqual({ ok: true, affected: 50, failed: 0 });
    expect(update).toHaveBeenCalledTimes(50);
    expect(new Set(update.mock.calls.map(([, input]) => input.itemShortId)).size).toBe(50);
    expect(peak).toBe(4);
  });

  it("counts a failing item without stopping the rest", async () => {
    found(ids(6));
    update.mockImplementation(async (_actor, input: { itemShortId: string }) =>
      input.itemShortId === "FB-3" ? Promise.reject(new Error("smtp down")) : { ok: true, emailed: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await bulkUpdateStatus(ids(6), "shipped")).toEqual({ ok: true, affected: 5, failed: 1, firstError: "update_failed" });
  });

  it("leaves merged duplicates to the item they were merged into, and says how many", async () => {
    found(["i1", "i2", "i3"], [{}, { mergedIntoId: "i1" }, {}]);
    update.mockResolvedValue({ ok: true, emailed: false });
    expect(await bulkUpdateStatus(["i1", "i2", "i3"], "review")).toEqual({ ok: true, affected: 2, failed: 0, skipped: 1 });
    expect(update.mock.calls.map(([, input]) => input.itemShortId)).toEqual(["FB-1", "FB-3"]);
  });

  it("tells a customer about each of their requests, with no cross-item dedupe", async () => {
    found(["i1", "i2"]);
    update.mockResolvedValue({ ok: true, emailed: true, mergedEmailed: 0 });
    expect(await bulkUpdateStatus(["i1", "i2"], "shipped")).toEqual({ ok: true, affected: 2, failed: 0 });
    // Each item runs the core on its own terms: nothing tells one to skip a
    // person another item reaches, so each request gets its email and ledger row.
    expect(update.mock.calls.map(([, input, opts]) => [input.itemShortId, opts?.alreadyTold])).toEqual([
      ["FB-1", undefined],
      ["FB-2", undefined],
    ]);
  });
});
