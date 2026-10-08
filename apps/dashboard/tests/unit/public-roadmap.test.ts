import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, changelogEntries, initiatives, publicFollows, roadmapFollows, accounts, accountUsers, workspaces, workspaceUsers } from "@crumb/db";
import type { OutgoingEmail } from "@/lib/email/provider";

// The board's server actions and the follower emails run for real, through a
// real provider (SMTP, faked at the transport; set before lib/email picks and
// caches its provider). The notifiers are watched, so a test can see who the
// board told and wait for the emails it doesn't wait for.
const h = vi.hoisted(() => {
  process.env.CRUMB_EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.test";
  process.env.CRUMB_EMAIL_FROM = "Crumb <crumb@mail.example.com>";
  return { session: null as unknown, sent: [] as OutgoingEmail[], notify: vi.fn(), notifyPublic: vi.fn() };
});
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("@/lib/email/smtp", () => ({
  makeSmtpProvider: () => ({
    name: "smtp",
    send: async (m: OutgoingEmail) => { h.sent.push(m); return { ok: true as const, providerMessageId: null }; },
  }),
}));
vi.mock("@/lib/roadmap-notify", async (load) => {
  const real = await load<typeof import("@/lib/roadmap-notify")>();
  return { ...real, notifyRoadmapFollowers: h.notify.mockImplementation(real.notifyRoadmapFollowers) };
});
vi.mock("@/lib/public-follows", async (load) => {
  const real = await load<typeof import("@/lib/public-follows")>();
  return { ...real, notifyPublicFollowers: h.notifyPublic.mockImplementation(real.notifyPublicFollowers) };
});
// Every follower email the board has fired off so far, sent.
const settled = async () => {
  await Promise.all(h.notify.mock.results.map(r => r.value));
  await Promise.all(h.notifyPublic.mock.results.map(r => r.value));
};

import { followerCountSql, listPublicRoadmap, onPublicRoadmapSql } from "@/lib/roadmap";
import { moveInitiative, reorderInitiatives } from "@/app/(app)/initiatives/actions";

// The customer roadmap (widget, public page, setup checklist): public cards in
// Now, Next and Later in board order, then the newest shipped ones. A public
// card left in Unscheduled, and anything private, stays out.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("the public roadmap", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    delete process.env.CRUMB_EMAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    for (const id of created) await db.delete(workspaces).where(eq(workspaces.id, id));
  });

  it("lists what customers can see, lane by lane, newest shipped first", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `roadmap-${randomUUID().slice(0, 8)}`, name: "Acme" })
      .returning();
    created.push(ws!.id);
    const day = (d: string) => new Date(`2026-${d}T12:00:00Z`);
    const rows = await db.insert(initiatives).values([
      { seq: 1, shortId: "IN-1", name: "Exports", roadmapColumn: "now", roadmapOrder: 1, isPublic: true },
      { seq: 2, shortId: "IN-2", name: "SSO", roadmapColumn: "now", roadmapOrder: 0, isPublic: true, status: "in_progress" },
      { seq: 3, shortId: "IN-3", name: "Audit log", roadmapColumn: "next", isPublic: true, description: "Who did what." },
      { seq: 4, shortId: "IN-4", name: "Secret", roadmapColumn: "later" },
      // Public but unscheduled: the switch is on, but customers can't see it.
      { seq: 5, shortId: "IN-5", name: "Someday", isPublic: true },
      // Shipped: the draft written at ship time dates it, even after a later edit.
      { seq: 6, shortId: "IN-6", name: "Dark mode", roadmapColumn: "now", isPublic: true, status: "shipped", updatedAt: day("10-01") },
      // Shipped from Unscheduled with no draft: its last edit dates it.
      { seq: 7, shortId: "IN-7", name: "Webhooks", isPublic: true, status: "shipped", updatedAt: day("09-15") },
      { seq: 8, shortId: "IN-8", name: "Billing", roadmapColumn: "later", isPublic: true, status: "shipped", updatedAt: day("10-02") },
      { seq: 9, shortId: "IN-9", name: "Internal", isPublic: false, status: "shipped" },
    ].map(r => ({ ...r, workspaceId: ws!.id }))).returning({ id: initiatives.id, shortId: initiatives.shortId });
    const id = Object.fromEntries(rows.map(r => [r.shortId, r.id]));
    await db.insert(changelogEntries).values([
      { workspaceId: ws!.id, initiativeId: id["IN-6"]!, title: "Dark mode", createdAt: day("09-01") },
      { workspaceId: ws!.id, initiativeId: id["IN-8"]!, title: "Billing", createdAt: day("09-20") },
    ]);

    const all = await listPublicRoadmap(ws!.id);
    const lane = (l: string) => all.filter(e => e.lane === l).map(e => e.shortId);
    expect(lane("now")).toEqual(["IN-2", "IN-1"]);
    expect(lane("next")).toEqual(["IN-3"]);
    expect(lane("later")).toEqual([]);
    expect(lane("shipped")).toEqual(["IN-8", "IN-7", "IN-6"]);
    expect(all.find(e => e.shortId === "IN-3")).toEqual({
      id: id["IN-3"], shortId: "IN-3", name: "Audit log", description: "Who did what.",
      lane: "next", status: "open", shippedAt: null,
    });
    expect(Object.fromEntries(all.filter(e => e.lane === "shipped").map(e => [e.shortId, e.shippedAt]))).toEqual({
      "IN-8": day("09-20").toISOString(),
      "IN-7": day("09-15").toISOString(),
      "IN-6": day("09-01").toISOString(),
    });

    // The shipped lane keeps only the most recent.
    expect((await listPublicRoadmap(ws!.id, { shippedLimit: 1 })).filter(e => e.lane === "shipped").map(e => e.shortId))
      .toEqual(["IN-8"]);

    // The setup checklist's "Publish your roadmap" counts the same cards.
    const [visible] = await db.select({ n: sql<number>`count(*)::int` }).from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws!.id), onPublicRoadmapSql()));
    expect(visible!.n).toBe(6);
  });

  it("counts widget followers and confirmed public followers, not pending or unsubscribed ones", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `roadmap-${randomUUID().slice(0, 8)}`, name: "Acme", publicPagesEnabled: true })
      .returning();
    created.push(ws!.id);
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "SSO", roadmapColumn: "now", isPublic: true })
      .returning({ id: initiatives.id });
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const [ann] = await db.insert(accountUsers)
      .values({ workspaceId: ws!.id, accountId: acct!.id, email: "ann@initech.test", name: "Ann", initials: "A" })
      .returning({ id: accountUsers.id });
    await db.insert(roadmapFollows).values({ workspaceId: ws!.id, initiativeId: ini!.id, accountUserId: ann!.id });
    const now = new Date();
    await db.insert(publicFollows).values([
      { email: "a@x.test", confirmedAt: now },                       // counts
      { email: "b@x.test" },                                         // never confirmed
      { email: "c@x.test", confirmedAt: now, unsubscribedAt: now },  // left
    ].map((f, i) => ({ ...f, workspaceId: ws!.id, initiativeId: ini!.id, tokenHash: `${ws!.id}-${i}` })));
    // Following every update isn't following this initiative.
    await db.insert(publicFollows).values({ workspaceId: ws!.id, email: "d@x.test", confirmedAt: now, tokenHash: `${ws!.id}-all` });

    // Joined as the board and header tiles select it.
    const followers = async () => (await db.select({ n: followerCountSql(), owner: workspaceUsers.name })
      .from(initiatives)
      .leftJoin(workspaceUsers, eq(workspaceUsers.id, initiatives.ownerWorkspaceUserId))
      .where(eq(initiatives.id, ini!.id)))[0]!.n;
    expect(await followers()).toBe(2);
    // With the public pages off, nobody from them is emailed, so nobody counts.
    await db.update(workspaces).set({ publicPagesEnabled: false }).where(eq(workspaces.id, ws!.id));
    expect(await followers()).toBe(1);
  });

  it("keeps a shipped card out of column order and move emails, and tells followers of a public move", async () => {
    vi.stubEnv("CRUMB_APP_URL", "https://crumb.test");
    const [ws] = await db.insert(workspaces)
      .values({ slug: `roadmap-${randomUUID().slice(0, 8)}`, name: "Acme", publicPagesEnabled: true })
      .returning();
    created.push(ws!.id);
    h.session = { workspace: ws, user: { id: "u-1", role: "pm" } };
    const shippedOn = new Date("2026-09-01T12:00:00Z");
    const rows = await db.insert(initiatives).values([
      // Shipped from Now: it shows in Shipped, dated by its last edit.
      { seq: 1, shortId: "IN-1", name: "Dark mode", roadmapColumn: "now", isPublic: true, status: "shipped", updatedAt: shippedOn },
      { seq: 2, shortId: "IN-2", name: "SSO", roadmapColumn: "now", roadmapOrder: 1, isPublic: true },
      { seq: 3, shortId: "IN-3", name: "Exports", roadmapColumn: "next", isPublic: true },
    ].map(r => ({ ...r, workspaceId: ws!.id }))).returning({ id: initiatives.id, shortId: initiatives.shortId });
    const id = Object.fromEntries(rows.map(r => [r.shortId, r.id]));

    // Exports lands after SSO, and the shipped card keeps its place and date.
    expect(await moveInitiative(id["IN-3"]!, "now")).toEqual({ ok: true });
    const now = await db.select({ shortId: initiatives.shortId, order: initiatives.roadmapOrder, updatedAt: initiatives.updatedAt })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws!.id), eq(initiatives.roadmapColumn, "now")))
      .orderBy(asc(initiatives.shortId));
    expect(now.map(r => [r.shortId, r.order])).toEqual([["IN-1", 0], ["IN-2", 0], ["IN-3", 1]]);
    expect(now[0]!.updatedAt).toEqual(shippedOn);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: ws!.id, slug: ws!.slug }), id["IN-3"], "Exports", "moved to Now", "https://crumb.test",
    );
    await settled();

    // A shipped card changing column is no news to anyone following it.
    h.notify.mockClear();
    h.notifyPublic.mockClear();
    expect(await reorderInitiatives("later", [id["IN-1"]!])).toEqual({ ok: true });
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.notifyPublic).not.toHaveBeenCalled();
  });

  it("emails each follower of a public move once, from the widget or the public page", async () => {
    vi.stubEnv("CRUMB_APP_URL", "https://crumb.test");
    const [ws] = await db.insert(workspaces)
      .values({ slug: `roadmap-${randomUUID().slice(0, 8)}`, name: "Acme", publicPagesEnabled: true })
      .returning();
    created.push(ws!.id);
    h.session = { workspace: ws, user: { id: "u-1", role: "pm" } };
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "SSO", roadmapColumn: "next", isPublic: true })
      .returning({ id: initiatives.id });
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const [ann] = await db.insert(accountUsers)
      .values({ workspaceId: ws!.id, accountId: acct!.id, email: "ann@initech.test", name: "Ann", initials: "A" })
      .returning({ id: accountUsers.id });
    await db.insert(roadmapFollows).values({ workspaceId: ws!.id, initiativeId: ini!.id, accountUserId: ann!.id });
    // Ann follows from the public page too; Pat only from there.
    await db.insert(publicFollows).values(["ann@initech.test", "pat@x.test"].map((email, i) => ({
      workspaceId: ws!.id, initiativeId: ini!.id, email, confirmedAt: new Date(), tokenHash: `${ws!.id}-move-${i}`,
    })));

    h.sent.length = 0;
    expect(await reorderInitiatives("now", [ini!.id])).toEqual({ ok: true });
    await settled();
    expect(h.sent.map(m => `${m.to} ${m.subject}`).sort()).toEqual([
      "ann@initech.test Moved to Now: SSO",
      "pat@x.test Moved to Now: SSO",
    ]);
  });
});
