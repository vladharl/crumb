import { afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db, accounts, accountUsers, changelogEntries, customerNotifications, initiatives, items, publicFollows,
  roadmapFollows, workspaces, workspaceUsers,
} from "@crumb/db";
import type { OutgoingEmail } from "@/lib/email/provider";

// A real provider (SMTP, faked at the transport) so sends count as delivered.
// The public followers' own email is lib/public-follows' job: here it records
// what it was asked to send (who to skip, sorted) and reports 2 sent.
const h = vi.hoisted(() => {
  process.env.CRUMB_EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.test";
  process.env.CRUMB_EMAIL_FROM = "Crumb <crumb@mail.example.com>";
  return { sent: [] as OutgoingEmail[], notified: [] as unknown[] };
});
vi.mock("@/lib/email/smtp", () => ({
  makeSmtpProvider: () => ({
    name: "smtp",
    send: async (m: OutgoingEmail) => { h.sent.push(m); return { ok: true as const, providerMessageId: null }; },
  }),
}));
vi.mock("@/lib/public-follows", () => ({
  notifyPublicFollowers: async (input: { skip?: Iterable<string> }) => {
    h.notified.push({ ...input, skip: [...(input.skip ?? [])].sort() });
    return 2;
  },
}));
// The copy helpers live beside the publish controls; their server actions aren't needed here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/(app)/changelog/actions", () => ({ publishEntry: vi.fn() }));
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({}));

import { announcementAudience, listPublicChangelog, publishChangelogEntry } from "@/lib/changelog";
import { audienceLine, publishedMessage } from "@/app/(app)/changelog/Announce";

// Publishing reaches the public pages' email followers too, counted in the
// confirm and the toast, and never emails a customer twice about it: not the
// announcement after their own request's Shipped email told them, and not the
// follower email after either.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];
const none = { count: 0, sources: [], noEmail: false, muted: false };

describe.skipIf(!reachable && !process.env.CI)("changelog followers and order", () => {
  afterAll(async () => {
    delete process.env.CRUMB_EMAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("leaves out who already heard, emails public followers, and lists newest first", async () => {
    const slug = `followers-${randomUUID().slice(0, 8)}`;
    const [ws] = await db.insert(workspaces).values({ slug, name: "Acme", publicPagesEnabled: true }).returning();
    created.push(ws!.id);
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const people = await db.insert(accountUsers).values([
      { email: "ann@initech.test", name: "Ann", initials: "A" }, // asked; told when her request shipped
      { email: "bob@initech.test", name: "Bob", initials: "B" }, // asked; still open
      { email: "fay@initech.test", name: "Fay", initials: "F" }, // follows; told when her merged request shipped
      { email: "dee@initech.test", name: "Dee", initials: "D" }, // follows; told about another initiative's request
    ].map(p => ({ ...p, workspaceId: ws!.id, accountId: acct!.id }))).returning({ id: accountUsers.id, email: accountUsers.email });
    const id = Object.fromEntries(people.map(p => [p.email.split("@")[0]!, p.id]));
    const [ini, other] = await db.insert(initiatives).values([
      { workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dark mode", status: "shipped" },
      { workspaceId: ws!.id, seq: 2, shortId: "IN-2", name: "Exports" },
    ]).returning({ id: initiatives.id });
    const base = { workspaceId: ws!.id, accountId: acct!.id, type: "idea", source: "widget" };
    const [fb1] = await db.insert(items)
      .values({ ...base, submitterId: id.ann!, seq: 1, shortId: "FB-1", title: "Dark theme please", initiativeId: ini!.id, status: "shipped" })
      .returning({ id: items.id });
    const [, fb3, fb4] = await db.insert(items).values([
      { ...base, submitterId: id.bob!, seq: 2, shortId: "FB-2", title: "Night mode", initiativeId: ini!.id },
      { ...base, submitterId: id.fay!, seq: 3, shortId: "FB-3", title: "Night theme", status: "duplicate", mergedIntoId: fb1!.id },
      { ...base, submitterId: id.dee!, seq: 4, shortId: "FB-4", title: "CSV export", initiativeId: other!.id, status: "shipped" },
    ]).returning({ id: items.id });
    await db.insert(customerNotifications).values([
      { itemId: fb1!.id, accountUserId: id.ann!, kind: "status", toStatus: "shipped" },
      { itemId: fb3!.id, accountUserId: id.fay!, kind: "status", toStatus: "shipped" },
      { itemId: fb4!.id, accountUserId: id.dee!, kind: "status", toStatus: "shipped" },
    ]);
    await db.insert(roadmapFollows).values(
      [id.fay!, id.dee!].map(accountUserId => ({ workspaceId: ws!.id, initiativeId: ini!.id, accountUserId })),
    );
    // Confirmed and subscribed, all updates or this initiative, once per address,
    // and not the customers it emails or who already heard.
    const at = new Date();
    await db.insert(publicFollows).values([
      { email: "pat@pub.test", initiativeId: null, confirmedAt: at },
      { email: "pat@pub.test", initiativeId: ini!.id, confirmedAt: at },
      { email: "quinn@pub.test", initiativeId: ini!.id, confirmedAt: at },
      { email: "ann@initech.test", initiativeId: null, confirmedAt: at },               // already heard
      { email: "bob@initech.test", initiativeId: ini!.id, confirmedAt: at },            // gets the announcement
      { email: "una@pub.test", initiativeId: null },                                    // never confirmed
      { email: "val@pub.test", initiativeId: null, confirmedAt: at, unsubscribedAt: at }, // unsubscribed
      { email: "otto@pub.test", initiativeId: other!.id, confirmedAt: at },              // another initiative
    ].map(f => ({ ...f, workspaceId: ws!.id, tokenHash: randomUUID() })));
    const [entry, manual, internal] = await db.insert(changelogEntries).values([
      { workspaceId: ws!.id, initiativeId: ini!.id, title: "Dark mode is here", body: "Find it under Settings." },
      { workspaceId: ws!.id, title: "Faster search", body: "" },
      { workspaceId: ws!.id, title: "Ops note", body: "", isPublic: false },
    ]).returning();

    // The confirm: Ann and Fay already heard, so Bob and Dee get it, plus two followers.
    const audience = await announcementAudience(ws!.id, ini!.id);
    expect(audience).toEqual({ reach: 2, followers: 2, alreadyHeard: 2, skipped: none, emailOn: true, openItems: 1 });
    expect(audienceLine(audience)).toBe(
      "Publishing emails 2 customers who asked for this or follow it, and 2 followers of your public pages. 2 already heard when their request shipped.",
    );
    // A hand-written entry is news to Ann.
    expect(await announcementAudience(ws!.id, null)).toMatchObject({ reach: 0, followers: 2, alreadyHeard: 0, openItems: 0 });

    const r = await publishChangelogEntry(ws!, entry!.id, { origin: "https://crumb.test" });
    expect(r).toEqual({ ok: true, announced: true, delivered: 2, failed: 0, followers: 2, skipped: none, emailOn: true, marked: 0 });
    if (!r.ok) return;
    expect(publishedMessage(r)).toBe("Sent to 2 customers and 2 followers.");
    expect(h.sent.map(m => m.to).sort()).toEqual(["bob@initech.test", "dee@initech.test"]);
    expect(h.notified).toEqual([{
      workspaceId: ws!.id, initiativeId: ini!.id, kind: "changelog",
      title: "Dark mode is here", summary: "Find it under Settings.", url: `https://crumb.test/${slug}/changelog`,
      skip: ["ann@initech.test", "bob@initech.test", "dee@initech.test", "fay@initech.test"],
    }]);

    // A hand-written entry goes to the all-updates followers; an internal one to no one.
    const plain = await publishChangelogEntry(ws!, manual!.id);
    expect(plain).toEqual({ ok: true, announced: false, followers: 2 });
    if (plain.ok) expect(publishedMessage(plain)).toBe("Published. Sent to 2 followers.");
    expect(h.notified.at(-1)).toMatchObject({ initiativeId: null, title: "Faster search", url: null, skip: [] });
    expect(await publishChangelogEntry(ws!, internal!.id)).toEqual({ ok: true, announced: false, followers: 0 });
    expect(h.notified).toHaveLength(2);

    // With the public pages off, followers aren't counted or told.
    await db.update(workspaces).set({ publicPagesEnabled: false }).where(eq(workspaces.id, ws!.id));
    expect((await announcementAudience(ws!.id, null)).followers).toBe(0);
    const [late] = await db.insert(changelogEntries)
      .values({ workspaceId: ws!.id, title: "Quiet fix", body: "" })
      .returning({ id: changelogEntries.id });
    expect(await publishChangelogEntry({ ...ws!, publicPagesEnabled: false }, late!.id)).toEqual({ ok: true, announced: false, followers: 0 });
    expect(h.notified).toHaveLength(2);

    // Newest first, published and public only.
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await db.update(changelogEntries).set({ publishedAt: day(3) }).where(eq(changelogEntries.id, entry!.id));
    await db.update(changelogEntries).set({ publishedAt: day(1) }).where(eq(changelogEntries.id, manual!.id));
    await db.update(changelogEntries).set({ publishedAt: day(2) }).where(eq(changelogEntries.id, late!.id));
    await db.insert(changelogEntries).values({ workspaceId: ws!.id, title: "Draft", body: "" });
    expect((await listPublicChangelog(ws!.id)).map(e => e.title)).toEqual(["Dark mode is here", "Quiet fix", "Faster search"]);
  });

  it("leaves out a follower the Shipped email about their own request just told", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `followers-${randomUUID().slice(0, 8)}`, name: "Acme", publicPagesEnabled: true })
      .returning();
    created.push(ws!.id);
    const [pm] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws!.id, email: "pat@acme.test", name: "Pat", initials: "P", role: "admin" })
      .returning({ id: workspaceUsers.id });
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    // Roadmap emails off, so the announcement skips Eve; Shipped emails on.
    const [eve] = await db.insert(accountUsers)
      .values({ workspaceId: ws!.id, accountId: acct!.id, email: "eve@initech.test", name: "Eve", initials: "E", notifyRoadmap: false })
      .returning({ id: accountUsers.id });
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dark mode", status: "shipped" })
      .returning({ id: initiatives.id });
    await db.insert(items).values({
      workspaceId: ws!.id, accountId: acct!.id, submitterId: eve!.id, initiativeId: ini!.id,
      seq: 1, shortId: "FB-1", title: "Dark theme please", type: "idea", source: "widget",
    });
    const [entry] = await db.insert(changelogEntries)
      .values({ workspaceId: ws!.id, initiativeId: ini!.id, title: "Dark mode is here", body: "" })
      .returning({ id: changelogEntries.id });

    h.sent.length = 0;
    const r = await publishChangelogEntry(ws!, entry!.id, {
      origin: "https://crumb.test",
      markShipped: { workspaceId: ws!.id, actorWorkspaceUserId: pm!.id, role: "admin" },
    });
    expect(r).toMatchObject({ ok: true, delivered: 0, marked: 1 });
    expect(h.sent.map(m => [m.to, m.subject])).toEqual([["eve@initech.test", "Shipped: Dark theme please"]]);
    expect(h.notified.at(-1)).toMatchObject({ title: "Dark mode is here", skip: ["eve@initech.test"] });
  });
});
