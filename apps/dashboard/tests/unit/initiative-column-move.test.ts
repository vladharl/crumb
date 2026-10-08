import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, initiatives, roadmapFollows, accountUsers, accounts, workspaces } from "@crumb/db";

// Moving an initiative without a drag (the edit panel's Column control).
// useColumnMove runs under a one-render stand-in for React, as useStatusMove
// does in reply-composer.test.ts: state keeps its first value, refs are plain
// objects, and effects are collected so a test can mount and unmount them.
// moveInitiative runs for real against Postgres in the second block.
const h = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  move: vi.fn(async (_id: string, _column: string | null) => ({ ok: true as const })),
  toast: { show: vi.fn((_opts: { message: string; action?: { onClick: () => void } }) => 7), dismiss: vi.fn((_id: number) => {}) },
  session: null as unknown,
  notify: vi.fn(async () => {}),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => [typeof init === "function" ? init() : init, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: (fn: () => unknown) => { h.effects.push(fn); },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/components/toast", () => ({ useToast: () => h.toast }));
vi.mock("@/components/confirm", () => ({ useConfirm: () => async () => true }));
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({}));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("@/lib/roadmap-notify", () => ({ notifyRoadmapFollowers: h.notify }));
vi.mock("@/app/(app)/initiatives/actions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/(app)/initiatives/actions")>();
  // The hook's calls are recorded; the second block calls the real action.
  return { ...real, moveInitiative: h.move, realMoveInitiative: real.moveInitiative };
});

import { STATUS_EMAIL_DELAY_MS } from "@/components/ReplyComposer";
import * as actions from "@/app/(app)/initiatives/actions";
import { useColumnMove } from "@/app/(app)/initiatives/useColumnMove";

// A window/document stand-in that records listeners (sendAfterDelay's hide/leave saves).
function eventTarget() {
  const on = new Map<string, Set<() => void>>();
  return {
    visibilityState: "visible",
    addEventListener: (type: string, fn: () => void) => { on.set(type, (on.get(type) ?? new Set()).add(fn)); },
    removeEventListener: (type: string, fn: () => void) => { on.get(type)?.delete(fn); },
  };
}

describe("useColumnMove (a move that emails followers waits behind Undo)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", eventTarget());
    vi.stubGlobal("document", eventTarget());
    h.move.mockClear();
    h.toast.show.mockClear();
    h.toast.dismiss.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Renders the hook for an initiative in Now (public, 3 followers unless
  // overridden) and runs its effects, as mounting would.
  function mount(card: Partial<{ isPublic: boolean; followers: number }> = {}) {
    h.effects.length = 0;
    const { move } = useColumnMove({ id: "ini-1", column: "now", isPublic: true, followers: 3, ...card });
    const cleanups = h.effects.map(effect => effect());
    return { move, unmount: () => { for (const c of cleanups) if (typeof c === "function") c(); } };
  }
  const lastToast = () => h.toast.show.mock.calls.at(-1)![0];

  it("saves once the undo window ends", () => {
    const m = mount();
    m.move("next");
    expect(lastToast().message).toBe("Moved to Next. Emailing its followers in 6 seconds.");
    expect(h.move).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STATUS_EMAIL_DELAY_MS);
    expect(h.move).toHaveBeenCalledWith("ini-1", "next");
    m.unmount();
    expect(h.move).toHaveBeenCalledTimes(1);
  });

  it("Undo inside the window saves nothing and says no one was emailed", () => {
    const m = mount();
    m.move("later");
    lastToast().action!.onClick();
    expect(lastToast().message).toBe("Undone. Its followers weren't emailed.");
    vi.advanceTimersByTime(60_000);
    m.unmount();
    expect(h.move).not.toHaveBeenCalled();
  });

  it("the latest pick wins, and picking the old column again is an undo", () => {
    const m = mount();
    m.move("next");
    m.move("later");
    vi.advanceTimersByTime(STATUS_EMAIL_DELAY_MS);
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(h.move).toHaveBeenCalledWith("ini-1", "later");

    h.move.mockClear();
    m.move("next");
    m.move("now"); // where the server still has it
    expect(lastToast().message).toBe("Undone. Its followers weren't emailed.");
    vi.advanceTimersByTime(60_000);
    expect(h.move).not.toHaveBeenCalled();
  });

  it("saves at once when nobody would be emailed", () => {
    mount({ isPublic: false }).move("later");          // private
    mount({ followers: 0 }).move("next");              // nobody follows it
    mount().move(null);                                 // Unscheduled leaves the roadmap
    expect(h.move.mock.calls).toEqual([["ini-1", "later"], ["ini-1", "next"], ["ini-1", null]]);
    expect(h.toast.show).not.toHaveBeenCalled();
  });

  it("leaving the page saves a waiting move at once and ends its Undo", () => {
    const m = mount();
    m.move("next");
    m.unmount();
    expect(h.move).toHaveBeenCalledWith("ini-1", "next");
    expect(h.toast.dismiss).toHaveBeenCalledWith(7);
    vi.advanceTimersByTime(60_000);
    expect(h.move).toHaveBeenCalledTimes(1);
  });
});

// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("moveInitiative (the server side of the Column control)", () => {
  const moveInitiative = (actions as unknown as { realMoveInitiative: typeof actions.moveInitiative }).realMoveInitiative;

  afterAll(async () => {
    for (const id of created) await db.delete(workspaces).where(eq(workspaces.id, id));
  });

  it("puts the card at the end of the column in board order, and emails followers only when a public card is scheduled", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `colmove-${randomUUID().slice(0, 8)}`, name: "Acme" })
      .returning();
    created.push(ws!.id);
    h.session = { workspace: ws, user: { id: "u-1", role: "pm" } };
    const cards = await db.insert(initiatives).values([
      // Now holds two tied cards, which the board sorts by short id (IN-10
      // before IN-9, unlike their seq), and one after them.
      { seq: 9, shortId: "IN-9", name: "Dark mode", roadmapColumn: "now", roadmapOrder: 0, isPublic: true },
      { seq: 10, shortId: "IN-10", name: "SSO", roadmapColumn: "now", roadmapOrder: 0 },
      { seq: 2, shortId: "IN-2", name: "Exports", roadmapColumn: "now", roadmapOrder: 1 },
      { seq: 3, shortId: "IN-3", name: "Audit log", roadmapColumn: null, roadmapOrder: 0 },
    ].map(c => ({ ...c, workspaceId: ws!.id }))).returning({ id: initiatives.id, shortId: initiatives.shortId });
    const id = Object.fromEntries(cards.map(c => [c.shortId, c.id]));
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const [ann] = await db.insert(accountUsers)
      .values({ workspaceId: ws!.id, accountId: acct!.id, email: "ann@initech.test", name: "Ann", initials: "A" })
      .returning({ id: accountUsers.id });
    await db.insert(roadmapFollows).values({ workspaceId: ws!.id, initiativeId: id["IN-9"]!, accountUserId: ann!.id });
    const column = async (col: string | null) => (await db.select({ shortId: initiatives.shortId, order: initiatives.roadmapOrder })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws!.id), col === null ? isNull(initiatives.roadmapColumn) : eq(initiatives.roadmapColumn, col)))
      .orderBy(asc(initiatives.roadmapOrder))).map(r => `${r.shortId}:${r.order}`);

    // Unscheduled into Now: last, and the cards above keep the order the board showed.
    h.notify.mockClear();
    expect(await moveInitiative(id["IN-3"]!, "now")).toEqual({ ok: true });
    expect(await column("now")).toEqual(["IN-10:0", "IN-9:1", "IN-2:2", "IN-3:3"]);
    expect(h.notify).not.toHaveBeenCalled(); // private

    // The public card moving to Next tells its followers; unscheduling it doesn't.
    expect(await moveInitiative(id["IN-9"]!, "next")).toEqual({ ok: true });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]!.slice(0, 4)).toEqual([expect.objectContaining({ id: ws!.id }), id["IN-9"], "Dark mode", "moved to Next"]);
    expect(await moveInitiative(id["IN-9"]!, null)).toEqual({ ok: true });
    expect(await column(null)).toEqual(["IN-9:0"]);
    expect(h.notify).toHaveBeenCalledTimes(1);

    expect(await moveInitiative(id["IN-2"]!, "soon")).toEqual({ ok: false, error: "bad_column" });
    h.session = { workspace: ws, user: { id: "u-2", role: "viewer" } };
    expect(await moveInitiative(id["IN-2"]!, "later")).toEqual({ ok: false, error: "forbidden" });
  });
});
