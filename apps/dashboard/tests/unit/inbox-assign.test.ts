import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@crumb/db";

// Bulk assign runs each item through the assignment core (assignItemTo), so
// item.assigned fires exactly as from the thread, while the assignee hears
// once for the lot, and an Undo tells nobody. The session, request, core and
// notifier are faked.

const { assign, many } = vi.hoisted(() => ({ assign: vi.fn(), many: vi.fn() }));
vi.mock("@/lib/server", () => ({
  getActiveSession: async () => ({ workspace: { id: "ws-1" }, user: { id: "user-1", role: "pm" } }),
}));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/items/mutations", () => ({ assignItemTo: assign, updateItemStatus: vi.fn() }));
vi.mock("@/lib/vendor-notify", () => ({ notifyAssignedMany: many }));

import { bulkAssign } from "@/app/(app)/inbox/actions";

// The workspace-scoped lookup returns these rows.
function found(rows: Array<{ id: string; shortId: string; assigneeId: string | null }>) {
  vi.spyOn(db, "select").mockReturnValue({ from: () => ({ where: async () => rows }) } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  assign.mockReset();
  many.mockReset();
});

describe("bulkAssign", () => {
  it("assigns through the core, skipping items that already have that assignee, and alerts once", async () => {
    found([
      { id: "i1", shortId: "FB-1", assigneeId: null },
      { id: "i2", shortId: "FB-2", assigneeId: "alex" },
      { id: "i3", shortId: "FB-3", assigneeId: "sam" },
    ]);
    assign.mockResolvedValue({ ok: true });
    expect(await bulkAssign(["i1", "i2", "i3"], "alex")).toEqual({ ok: true, affected: 3 });
    const actor = { workspaceId: "ws-1", actorWorkspaceUserId: "user-1", role: "pm" };
    expect(assign.mock.calls).toEqual([
      [actor, { itemShortId: "FB-1", assigneeId: "alex" }, { notify: false }],
      [actor, { itemShortId: "FB-3", assigneeId: "alex" }, { notify: false }],
    ]);
    expect(many.mock.calls).toEqual([[{ workspaceId: "ws-1", itemIds: ["i1", "i3"], assigneeId: "alex", actorWorkspaceUserId: "user-1" }]]);
  });

  it("tells nobody on an Undo or an unassign", async () => {
    found([{ id: "i1", shortId: "FB-1", assigneeId: "alex" }]);
    assign.mockResolvedValue({ ok: true });
    expect(await bulkAssign(["i1"], "sam", { notify: false })).toEqual({ ok: true, affected: 1 });
    expect(await bulkAssign(["i1"], null)).toEqual({ ok: true, affected: 1 });
    expect(many).not.toHaveBeenCalled();
  });

  it("says why when nothing could be assigned", async () => {
    found([{ id: "i1", shortId: "FB-1", assigneeId: null }, { id: "i2", shortId: "FB-2", assigneeId: null }]);
    assign.mockResolvedValue({ ok: false, error: "not_a_member" });
    expect(await bulkAssign(["i1", "i2"], "gone")).toEqual({ ok: false, error: "not_a_member" });
  });
});
