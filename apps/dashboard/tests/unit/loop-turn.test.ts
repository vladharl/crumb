import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  db, accounts, accountUsers, customerNotifications, items, replies, statusEvents, workspaces, workspaceUsers,
} from "@crumb/db";
import { engDoneUntold, loopTurn, ticketDone } from "@/lib/loop";
import { lastTurnSideSql } from "@/lib/loop-sql";

// Whose turn it is comes from who moved last, not only from the last reply: a
// status email the customer got or Set aside ends your turn, and a later
// customer reply brings it back. The DB part runs against Postgres
// (DATABASE_URL, migrated via `pnpm db:migrate`); skipped locally when no
// database answers, CI has one.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe("lastTurnSideSql", () => {
  it("keeps the item column qualified even as a single-table select field", () => {
    const q = new QueryBuilder().select({ side: lastTurnSideSql(items.id) }).from(items).toSQL();
    expect(q.sql).toContain(`r.item_id = "items"."id"`);
    expect(q.sql).not.toMatch(/item_id = "id"/);
  });
});

describe.skipIf(!reachable && !process.env.CI)("lastTurnSideSql against Postgres", () => {
  const created: string[] = [];
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("gives the turn to whoever moved last, counting delivered status emails and Set aside", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `loop-turn-${randomUUID().slice(0, 8)}`, name: "Loop turn test" })
      .returning({ id: workspaces.id });
    created.push(ws.id);
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const [vic] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws.id, email: "vic@vendor.test", name: "Vic", initials: "V" })
      .returning({ id: workspaceUsers.id });

    const day = (n: number) => new Date(Date.UTC(2026, 5, 1 + n));
    type Move = ["customer" | "vendor" | "note" | "told" | "aside", number];
    const cases: Record<string, { status: string; moves: Move[]; side: "vendor" | "customer" | null; turn: string }> = {
      "FB-1": { status: "open", moves: [], side: null, turn: "yours" },
      "FB-2": { status: "open", moves: [["customer", 0]], side: "customer", turn: "yours" },
      "FB-3": { status: "open", moves: [["customer", 0], ["vendor", 1]], side: "vendor", turn: "waiting" },
      "FB-4": { status: "open", moves: [["customer", 0], ["vendor", 1], ["customer", 2]], side: "customer", turn: "yours" },
      "FB-5": { status: "planned", moves: [["customer", 0], ["told", 1]], side: "vendor", turn: "waiting" },
      "FB-6": { status: "deferred", moves: [["customer", 0], ["aside", 1]], side: "vendor", turn: "waiting" },
      "FB-7": { status: "deferred", moves: [["customer", 0], ["aside", 1], ["customer", 2]], side: "customer", turn: "yours" },
      "FB-8": { status: "open", moves: [["customer", 0], ["note", 1]], side: "customer", turn: "yours" },
    };

    let seq = 0;
    for (const [shortId, c] of Object.entries(cases)) {
      const [item] = await db.insert(items).values({
        workspaceId: ws.id, accountId: acct.id, submitterId: pat.id, seq: ++seq, shortId, title: shortId, type: "idea", status: c.status,
      }).returning({ id: items.id });
      for (const [kind, n] of c.moves) {
        if (kind === "customer") await db.insert(replies).values({ itemId: item.id, accountUserId: pat.id, body: "hi", createdAt: day(n) });
        if (kind === "vendor") await db.insert(replies).values({ itemId: item.id, workspaceUserId: vic.id, body: "on it", createdAt: day(n) });
        if (kind === "note") await db.insert(replies).values({ itemId: item.id, workspaceUserId: vic.id, body: "fyi", internal: true, createdAt: day(n) });
        if (kind === "told") await db.insert(customerNotifications).values({ itemId: item.id, accountUserId: pat.id, kind: "status", toStatus: "planned", sentAt: day(n) });
        if (kind === "aside") await db.insert(statusEvents).values({ itemId: item.id, fromStatus: "open", toStatus: "deferred", reason: "Q3", at: day(n) });
      }
    }

    // A single-table select: the case where an unwrapped column would lose its table.
    const rows = await db
      .select({ shortId: items.shortId, status: items.status, side: lastTurnSideSql(items.id) })
      .from(items)
      .where(eq(items.workspaceId, ws.id));
    const got = Object.fromEntries(rows.map(r => [r.shortId, { side: r.side, turn: loopTurn({ status: r.status, lastReplySide: r.side }) }]));
    const want = Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, { side: c.side, turn: c.turn }]));
    expect(got).toEqual(want);
  });
});

describe("ticketDone", () => {
  it("knows each tracker's done states and nothing else", () => {
    for (const s of ["Done", "Completed", " done "]) expect(ticketDone("linear", s)).toBe(true);
    for (const s of ["Done", "Closed", "Resolved"]) expect(ticketDone("jira", s)).toBe(true);
    expect(ticketDone("github", "closed")).toBe(true);

    for (const s of ["In Progress", "Canceled", "Backlog"]) expect(ticketDone("linear", s)).toBe(false);
    expect(ticketDone("jira", "In Review")).toBe(false);
    expect(ticketDone("github", "open")).toBe(false);
    // What the GitHub webhook stores for an issue closed without doing the work.
    expect(ticketDone("github", "closed (not planned)")).toBe(false);
    expect(ticketDone("github", "closed (duplicate)")).toBe(false);
    expect(ticketDone(null, "Done")).toBe(false);
    expect(ticketDone("linear", null)).toBe(false);
  });
});

describe("engDoneUntold", () => {
  const base = {
    status: "planned",
    externalProvider: "linear",
    externalStatus: "Done",
    externalSyncedAtIso: "2026-06-10T00:00:00.000Z",
    lastNotifiedAtIso: null as string | null,
  };

  it("flags an open loop whose ticket is done when the customer hasn't heard since", () => {
    expect(engDoneUntold(base)).toBe(true);
    expect(engDoneUntold({ ...base, lastNotifiedAtIso: "2026-06-01T00:00:00.000Z" })).toBe(true);
  });

  it("clears once the customer was told after the ticket finished, or the loop closed", () => {
    expect(engDoneUntold({ ...base, lastNotifiedAtIso: "2026-06-11T00:00:00.000Z" })).toBe(false);
    expect(engDoneUntold({ ...base, status: "shipped" })).toBe(false);
    expect(engDoneUntold({ ...base, externalStatus: "In Progress" })).toBe(false);
  });
});
