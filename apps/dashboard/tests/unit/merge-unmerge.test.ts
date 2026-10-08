import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, dedupeSuggestions, items, replaySessions, statusEvents, workspaces, workspaceUsers } from "@crumb/db";

// Unmerge undoes a merge: the item gets back the status it had before (from
// its own history) and the replay sessions the merge moved to the canonical.
// A canonical merged later brings its duplicates along, and unmerging it
// brings them back with it. A merge accepts the duplicate suggestion that
// proposed it, whichever way round it went.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const h = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  emailConfigured: () => true,
  sendStatusChangeNotification: async () => true,
}));
vi.mock("@/lib/webhooks", () => ({ emitEvent: async () => {} }));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { mergeItems, mergeNotice, unmergeItem } from "@/app/(app)/thread/[shortId]/actions";

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("unmerge undoes a merge", () => {
  let wsId = "";
  const id: Record<string, string> = {};
  const session: Record<string, string> = {};
  const day = 86_400_000;
  const t0 = Date.now() - 10 * day;

  const item = (shortId: string) => db
    .select({ id: items.id, status: items.status, mergedIntoId: items.mergedIntoId })
    .from(items)
    .where(and(eq(items.workspaceId, wsId), eq(items.shortId, shortId)))
    .then(r => r[0]!);
  // Which item each replay session sits on, by item short id.
  const sessionsOn = async () => {
    const rows = await db
      .select({ token: replaySessions.sessionToken, on: items.shortId })
      .from(replaySessions)
      .innerJoin(items, eq(items.id, replaySessions.itemId))
      .where(eq(replaySessions.workspaceId, wsId));
    return Object.fromEntries(rows.map(r => [r.token, r.on]));
  };

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `unmerge-${randomUUID().slice(0, 8)}`, name: "Unmerge test" })
      .returning({ id: workspaces.id, slug: workspaces.slug });
    wsId = ws.id;
    const [lina] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws.id, email: "lina@vendor.test", name: "Lina", initials: "L", role: "admin" })
      .returning({ id: workspaceUsers.id });
    h.session = { workspace: { id: ws.id, slug: ws.slug }, user: { id: lina.id, role: "admin" } };

    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Initech" }).returning({ id: accounts.id });
    const person = async (name: string) => (await db.insert(accountUsers)
      .values({ workspaceId: ws.id, accountId: acct.id, email: `${name.toLowerCase()}@initech.test`, name, initials: name[0] })
      .returning({ id: accountUsers.id }))[0].id;
    const pat = await person("Pat");
    const maya = await person("Maya");
    const zed = await person("Zed");

    // Each item filed a day apart from a replay session that started an hour
    // before it. FB-3 is Pat's repeat of FB-1.
    const file = async (seq: number, submitterId: string, status = "open") => {
      const shortId = `FB-${seq}`;
      const createdAt = new Date(t0 + seq * day);
      const [row] = await db.insert(items).values({
        workspaceId: ws.id, accountId: acct.id, submitterId, seq, shortId, title: `Export ${seq}`, type: "idea",
        source: "widget", status, createdAt,
      }).returning({ id: items.id });
      id[shortId] = row.id;
      await db.insert(statusEvents).values({ itemId: row.id, fromStatus: null, toStatus: "open", at: createdAt });
      if (status !== "open") {
        await db.insert(statusEvents).values({ itemId: row.id, fromStatus: "open", toStatus: status, at: new Date(createdAt.getTime() + 1000) });
      }
      session[shortId] = randomUUID().replace(/-/g, "");
      await db.insert(replaySessions).values({
        workspaceId: ws.id, sessionToken: session[shortId], itemId: row.id, accountUserId: submitterId,
        startedAt: new Date(createdAt.getTime() - 3_600_000),
      });
    };
    await file(1, pat);
    await file(2, maya, "planned");
    await file(3, pat);
    await file(4, zed);
    await file(5, zed);
  });

  afterAll(async () => {
    if (!wsId) return;
    await db.delete(replaySessions).where(eq(replaySessions.workspaceId, wsId));
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("gives back the status from before the merge and the item's own replay sessions", async () => {
    expect(await mergeItems("FB-2", "FB-1")).toEqual({ ok: true, emailed: true });
    expect(await mergeItems("FB-3", "FB-1")).toEqual({ ok: true, emailed: true });
    expect(await sessionsOn()).toMatchObject({ [session["FB-1"]]: "FB-1", [session["FB-2"]]: "FB-1", [session["FB-3"]]: "FB-1", [session["FB-4"]]: "FB-4" });

    // Pat filed FB-1 and FB-3: only the session that led to FB-3 leaves.
    expect(await unmergeItem("FB-3")).toEqual({ ok: true, status: "open", carried: 0 });
    expect(await sessionsOn()).toMatchObject({ [session["FB-1"]]: "FB-1", [session["FB-2"]]: "FB-1", [session["FB-3"]]: "FB-3" });
    expect(await item("FB-3")).toMatchObject({ status: "open", mergedIntoId: null });
    const [last] = await db.select({ from: statusEvents.fromStatus, to: statusEvents.toStatus, reason: statusEvents.reason })
      .from(statusEvents).where(eq(statusEvents.itemId, id["FB-3"])).orderBy(desc(statusEvents.at)).limit(1);
    expect(last).toEqual({ from: "duplicate", to: "open", reason: "Unmerged from FB-1" });
  });

  it("moves a canonical's duplicates with it, and brings them back when it is unmerged", async () => {
    expect(await mergeNotice("FB-1")).toMatchObject({ ok: true, name: "Pat", carried: 1 });
    expect(await mergeItems("FB-1", "FB-4")).toEqual({ ok: true, emailed: true });
    // FB-2 follows FB-4 now, so its customer hears FB-4's outcome; the group
    // stays one level deep, and every session the group gathered moves too.
    expect(await item("FB-2")).toMatchObject({ status: "duplicate", mergedIntoId: id["FB-4"] });
    expect(await sessionsOn()).toMatchObject({ [session["FB-1"]]: "FB-4", [session["FB-2"]]: "FB-4", [session["FB-4"]]: "FB-4" });

    expect(await unmergeItem("FB-1")).toEqual({ ok: true, status: "open", carried: 1 });
    expect(await item("FB-1")).toMatchObject({ status: "open", mergedIntoId: null });
    expect(await item("FB-2")).toMatchObject({ status: "duplicate", mergedIntoId: id["FB-1"] });
    expect(await sessionsOn()).toMatchObject({ [session["FB-1"]]: "FB-1", [session["FB-2"]]: "FB-1", [session["FB-4"]]: "FB-4" });

    // And FB-2 itself goes back to Planned, with its session.
    expect(await unmergeItem("FB-2")).toEqual({ ok: true, status: "planned", carried: 0 });
    expect(await sessionsOn()).toEqual({
      [session["FB-1"]]: "FB-1", [session["FB-2"]]: "FB-2", [session["FB-3"]]: "FB-3", [session["FB-4"]]: "FB-4", [session["FB-5"]]: "FB-5",
    });
    const timeline = await db.select({ to: statusEvents.toStatus }).from(statusEvents)
      .where(eq(statusEvents.itemId, id["FB-2"])).orderBy(asc(statusEvents.at));
    expect(timeline.map(e => e.to)).toEqual(["open", "planned", "duplicate", "planned"]);
  });

  it("refuses to unmerge an item that isn't merged", async () => {
    expect(await unmergeItem("FB-2")).toEqual({ ok: false, error: "not_merged" });
  });

  it("never takes its canonical's other duplicates along with one that was only carried in", async () => {
    // FB-3 is FB-4's own duplicate, FB-1 joins FB-4 with FB-2, then FB-4 joins FB-5.
    for (const [from, into] of [["FB-3", "FB-4"], ["FB-2", "FB-1"], ["FB-1", "FB-4"], ["FB-4", "FB-5"]]) {
      expect(await mergeItems(from, into)).toMatchObject({ ok: true });
    }
    expect(await unmergeItem("FB-4")).toMatchObject({ ok: true, carried: 3 });
    // FB-1 arrived in FB-5 carried along with FB-4's own duplicates, so its own
    // group can't be told apart any more: it leaves alone, and FB-3 stays put.
    expect(await unmergeItem("FB-1")).toMatchObject({ ok: true, carried: 0 });
    expect(await item("FB-3")).toMatchObject({ mergedIntoId: id["FB-4"] });
    expect(await item("FB-2")).toMatchObject({ mergedIntoId: id["FB-4"] });
  });

  it("accepts the suggestion behind a merge, also when the vendor swapped its direction", async () => {
    const [pat] = await db.select({ id: accountUsers.id, accountId: accountUsers.accountId }).from(accountUsers)
      .where(and(eq(accountUsers.workspaceId, wsId), eq(accountUsers.email, "pat@initech.test")));
    const file = async (seq: number) => (await db.insert(items).values({
      workspaceId: wsId, accountId: pat!.accountId, submitterId: pat!.id, seq, shortId: `FB-${seq}`, title: `Export ${seq}`, type: "idea",
    }).returning({ id: items.id }))[0]!.id;
    const [six, seven, eight] = [await file(6), await file(7), await file(8)];
    // FB-6 was flagged as a duplicate of FB-7, and of FB-8.
    const [ofSeven, ofEight] = await db.insert(dedupeSuggestions).values([
      { itemId: six, candidateItemId: seven, similarity: 0.93 },
      { itemId: six, candidateItemId: eight, similarity: 0.9 },
    ]).returning({ id: dedupeSuggestions.id });
    const statusOf = async (s: { id: string } | undefined) => (await db.select({ status: dedupeSuggestions.status })
      .from(dedupeSuggestions).where(eq(dedupeSuggestions.id, s!.id)))[0]!.status;

    // Swapped: FB-7 folds into FB-6. Only FB-8 is still a question.
    expect(await mergeItems("FB-7", "FB-6")).toMatchObject({ ok: true });
    expect(await statusOf(ofSeven)).toBe("accepted");
    expect(await statusOf(ofEight)).toBe("pending");
  });
});
