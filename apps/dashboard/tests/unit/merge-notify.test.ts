import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, customerNotifications, items, statusEvents, workspaces, workspaceUsers } from "@crumb/db";
import type { ReplyNotification, StatusChangeNotification } from "@/lib/email";

// A request merged into another hears back: once at the merge, about its own
// item, then on each of the canonical's status changes (never its replies),
// under that customer's own prefs, with one ledger row per real delivery on
// their own item. Assigning someone else pings them (lib/vendor-notify).
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const h = vi.hoisted(() => ({
  status: [] as StatusChangeNotification[],
  replies: [] as ReplyNotification[],
  events: [] as Array<{ type: string; item?: { short_id: string } }>,
  assigned: [] as unknown[],
  session: null as unknown,
}));
// A real provider that accepts every send.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  emailConfigured: () => true,
  sendStatusChangeNotification: async (m: StatusChangeNotification) => { h.status.push(m); return true; },
  sendReplyNotification: async (m: ReplyNotification) => { h.replies.push(m); return true; },
}));
vi.mock("@/lib/webhooks", () => ({
  emitEvent: async (_ws: string, e: { type: string; item?: { short_id: string } }) => { h.events.push(e); },
}));
vi.mock("@/lib/notify/chat", () => ({ notifyWorkspaceChannel: async () => {} }));
vi.mock("@/lib/notify/account-channel", () => ({ notifyAccountChannels: async () => {} }));
vi.mock("@/lib/vendor-notify", () => ({ notifyAssigned: async (input: unknown) => { h.assigned.push(input); } }));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  assignItemTo, createItemReply, mergedReach, mergeNoticeText, notifyMergedItem, replyAndSetItemStatus, updateItemStatus,
} from "@/lib/items/mutations";
import { mergeItems, mergeNotice } from "@/app/(app)/thread/[shortId]/actions";

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const origin = "https://crumb.test";

describe.skipIf(!reachable && !process.env.CI)("merged requests hear back", () => {
  let wsId = "";
  let lina = "";
  let sam = "";
  let canonicalId = "";
  const people: Record<string, string> = {};
  const sid = { C: "FB-1", M: "FB-2", Q: "FB-3", Z: "FB-4", P: "FB-5", X: "FB-6" };
  const actor = () => ({ workspaceId: wsId, actorWorkspaceUserId: lina, role: "admin" as const });
  const inWs = (shortId: string) => and(eq(items.workspaceId, wsId), eq(items.shortId, shortId));
  const ledger = (shortId: string) => db
    .select({ kind: customerNotifications.kind, toStatus: customerNotifications.toStatus })
    .from(customerNotifications)
    .innerJoin(items, eq(items.id, customerNotifications.itemId))
    .where(inWs(shortId))
    .orderBy(asc(customerNotifications.sentAt));
  const timeline = (shortId: string) => db
    .select({ to: statusEvents.toStatus })
    .from(statusEvents)
    .innerJoin(items, eq(items.id, statusEvents.itemId))
    .where(inWs(shortId));
  const notified = () => h.events.filter(e => e.type === "customer.notified").map(e => e.item?.short_id);
  const clear = () => { h.status.length = 0; h.replies.length = 0; h.events.length = 0; };

  beforeAll(async () => {
    process.env.CRUMB_APP_URL = origin;
    const [ws] = await db.insert(workspaces).values({ slug: `merge-${randomUUID().slice(0, 8)}`, name: "Merge test" })
      .returning({ id: workspaces.id, slug: workspaces.slug });
    wsId = ws.id;
    const [l, s] = await db.insert(workspaceUsers).values([
      { workspaceId: ws.id, email: "lina@vendor.test", name: "Lina", initials: "L" },
      { workspaceId: ws.id, email: "sam@vendor.test", name: "Sam", initials: "S" },
    ]).returning({ id: workspaceUsers.id });
    lina = l.id;
    sam = s.id;
    h.session = { workspace: { id: ws.id, slug: ws.slug }, user: { id: lina, role: "admin" } };

    const acct = async (name: string) =>
      (await db.insert(accounts).values({ workspaceId: ws.id, name }).returning({ id: accounts.id }))[0].id;
    const initech = await acct("Initech");
    const globex = await acct("Globex");
    const umbrella = await acct("Umbrella");
    const person = async (key: string, accountId: string, email: string, name: string, extra: { notifyStatus?: boolean } = {}) => {
      const [u] = await db.insert(accountUsers).values({ workspaceId: ws.id, accountId, email, name, initials: name[0], ...extra })
        .returning({ id: accountUsers.id });
      people[key] = u.id;
    };
    await person("pat", initech, "pat@initech.test", "Pat Kim");
    await person("maya", globex, "maya@globex.test", "Maya Lopez");
    await person("quinn", globex, "quinn@globex.test", "Quinn", { notifyStatus: false });
    await person("zed", umbrella, "zed@umbrella.test", "Zed");
    await person("slack", umbrella, "slack-U1@slack.invalid", "Slack user");

    const item = async (key: keyof typeof sid, accountId: string, submitter: string, title: string, extra: object = {}) =>
      (await db.insert(items).values({
        workspaceId: ws.id, accountId, submitterId: people[submitter], seq: Number(sid[key].slice(3)), shortId: sid[key],
        title, type: "idea", source: "widget", ...extra,
      }).returning({ id: items.id }))[0].id;
    canonicalId = await item("C", initech, "pat", "Bulk export for Initech");
    await item("M", globex, "maya", "CSV export");
    // Already folded in: muted, pulled from Zendesk, Pat's own repeat, and a
    // placeholder address.
    const dup = { status: "duplicate", mergedIntoId: canonicalId };
    await item("Q", globex, "quinn", "Export to spreadsheet", dup);
    await item("Z", umbrella, "zed", "Export please", { ...dup, source: "zendesk" });
    await item("P", initech, "pat", "Bulk export again", dup);
    await item("X", umbrella, "slack", "Exports", { ...dup, source: null });
  });

  afterAll(async () => {
    delete process.env.CRUMB_APP_URL;
    if (!wsId) return;
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("tells the merged request's submitter once, about their own item only", async () => {
    expect(await mergeNotice(sid.M)).toEqual({ ok: true, name: "Maya Lopez", accountName: "Globex", source: "widget", plan: { willEmail: true } });
    expect(await mergeNotice(sid.Q)).toMatchObject({ ok: true, plan: { willEmail: false, reason: "muted" } });
    // The send follows the same plan: muted, pulled and placeholder addresses get nothing.
    for (const skip of [sid.Q, sid.Z, sid.X]) expect(await notifyMergedItem(actor(), { itemShortId: skip, origin })).toBe(false);
    expect(h.status).toEqual([]);

    expect(await mergeItems(sid.M, sid.C)).toEqual({ ok: true, emailed: true });
    // A repeated submit changes nothing and sends nothing.
    expect(await mergeItems(sid.M, sid.C)).toEqual({ ok: true, emailed: false });

    expect(h.status).toHaveLength(1);
    expect(h.status[0]).toMatchObject({
      to: "maya@globex.test", itemShortId: sid.M, itemTitle: "CSV export", fromStatus: null, toStatus: "duplicate",
      unsubscribeUrl: expect.stringContaining(`u=${people.maya}&`),
    });
    expect(h.status[0].reason).toMatch(/combined/);
    // Never the canonical's title, account or short id.
    expect(JSON.stringify(h.status[0])).not.toMatch(/Initech|Bulk export|FB-1\b/);
    expect(await ledger(sid.M)).toEqual([{ kind: "status", toStatus: "duplicate" }]);
    expect(notified()).toEqual([sid.M]);
    expect(await timeline(sid.M)).toEqual([{ to: "duplicate" }]);
  });

  it("sends the canonical's status changes to each merged submitter, about their own item", async () => {
    clear();
    // What the status controls show first: Maya, besides Pat (their own repeat
    // and the customers who can't be emailed don't count).
    expect(await mergedReach(wsId, canonicalId)).toBe(1);
    expect(await updateItemStatus(actor(), { itemShortId: sid.C, status: "deferred", reason: "Revisiting in Q3.", origin }))
      .toEqual({ ok: true, emailed: true, mergedEmailed: 1 });
    // Pat once (their own repeat is skipped); not the muted, Zendesk-pulled
    // or placeholder-address customers. Only Pat sees the typed reason: it
    // was written looking at Pat's request and could name Initech.
    expect(h.status.map(m => [m.to, m.itemShortId, m.itemTitle, m.reason ?? null])).toEqual([
      ["pat@initech.test", sid.C, "Bulk export for Initech", "Revisiting in Q3."],
      ["maya@globex.test", sid.M, "CSV export", null],
    ]);
    expect(h.status[1]).toMatchObject({ fromStatus: null, toStatus: "deferred", unsubscribeUrl: expect.stringContaining(`u=${people.maya}&`) });
    expect(await ledger(sid.M)).toEqual([{ kind: "status", toStatus: "duplicate" }, { kind: "status", toStatus: "deferred" }]);
    for (const quiet of [sid.Q, sid.Z, sid.P, sid.X]) expect(await ledger(quiet)).toEqual([]);
    expect(notified()).toEqual([sid.C, sid.M]);
  });

  it("never forwards a reply written to the canonical's customer", async () => {
    clear();
    await createItemReply(actor(), { itemShortId: sid.C, body: "Pat, Initech's export is next.", internal: false, origin });
    expect(h.replies.map(m => m.to)).toEqual(["pat@initech.test"]);
    // Reply-and-close: the reply rides in Pat's status email only.
    await replyAndSetItemStatus(actor(), { itemShortId: sid.C, body: "Pat, we won't build this for Initech.", status: "declined", origin });
    expect(h.status.map(m => [m.to, m.itemShortId, m.reason ?? null])).toEqual([
      ["pat@initech.test", sid.C, "Pat, we won't build this for Initech."],
      ["maya@globex.test", sid.M, null],
    ]);
    expect(h.replies.map(m => m.to)).toEqual(["pat@initech.test"]);
  });

  it("pings a new assignee, but not on a repeat, a self-assign or an unassign", async () => {
    for (const assigneeId of [sam, sam, lina, null]) {
      expect(await assignItemTo(actor(), { itemShortId: sid.C, assigneeId })).toEqual({ ok: true });
    }
    expect(h.assigned).toEqual([{ workspaceId: wsId, itemId: canonicalId, assigneeId: sam, actorWorkspaceUserId: lina }]);
  });

  it("tells a request merged into a closed one how it ended, and promises no news", async () => {
    clear();
    const [globex] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.workspaceId, wsId), eq(accounts.name, "Globex")));
    await db.insert(items).values({
      workspaceId: wsId, accountId: globex.id, submitterId: people.maya, seq: 7, shortId: "FB-7",
      title: "Export to Excel", type: "idea", source: "widget",
    });
    // The canonical was declined above.
    expect(await mergeItems("FB-7", sid.C)).toEqual({ ok: true, emailed: true });
    expect(h.status.map(m => [m.to, m.itemShortId, m.reason])).toEqual([
      ["maya@globex.test", "FB-7", "We've combined this with an earlier request for the same thing. We've decided not to take it on."],
    ]);
    expect(mergeNoticeText("shipped")).toBe("We've combined this with an earlier request for the same thing. It's already live.");
    expect(mergeNoticeText("resolved")).toBe("We've combined this with an earlier request for the same thing.");
    expect(mergeNoticeText("planned")).toMatch(/hear from us here when it moves/);
  });
});
