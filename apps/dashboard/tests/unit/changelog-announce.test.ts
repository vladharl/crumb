import { afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import {
  db, accounts, accountUsers, changelogEntries, customerNotifications, initiatives, items, roadmapFollows,
  workspaces, workspaceUsers,
} from "@crumb/db";
import type { OutgoingEmail } from "@/lib/email/provider";

// A real provider (SMTP, faked at the transport) so sends count as delivered,
// unlike stdout. Set before lib/email picks and caches its provider.
const h = vi.hoisted(() => {
  process.env.CRUMB_EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.test";
  process.env.CRUMB_EMAIL_FROM = "Crumb <crumb@mail.example.com>";
  // `reject` holds "to subject" pairs the provider turns down.
  return { sent: [] as OutgoingEmail[], reject: new Set<string>() };
});
vi.mock("@/lib/email/smtp", () => ({
  makeSmtpProvider: () => ({
    name: "smtp",
    send: async (m: OutgoingEmail) => {
      if (h.reject.has(`${m.to} ${m.subject}`)) return { ok: false as const, error: "rejected" };
      h.sent.push(m);
      return { ok: true as const, providerMessageId: null };
    },
  }),
}));
// The copy helpers live beside the publish controls; their server actions aren't needed here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/(app)/changelog/actions", () => ({ publishEntry: vi.fn() }));
vi.mock("@/app/(app)/thread/[shortId]/actions", () => ({}));

import { announcementAudience, draftChangelogForInitiative, publishChangelogEntry } from "@/lib/changelog";
import { publishedMessage } from "@/app/(app)/changelog/Announce";

// Shipping an initiative and announcing it: the count the vendor confirms is
// who actually gets emailed, each customer gets one email (the announcement,
// or their usual Shipped email when it can't reach them), the toast says who
// couldn't be reached and why, and the loop ledger records who was told.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("announcing a shipped initiative", () => {
  afterAll(async () => {
    delete process.env.CRUMB_EMAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("emails each customer once, names who it can't reach, and closes their loops", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `announce-${randomUUID().slice(0, 8)}`, name: "Acme" })
      .returning();
    created.push(ws!.id);
    const [pm] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws!.id, email: "pat@acme.test", name: "Pat", initials: "P", role: "admin" })
      .returning({ id: workspaceUsers.id });
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const people = await db.insert(accountUsers).values([
      { email: "ann@initech.test", name: "Ann", initials: "A" },                        // asked in the widget, follows too
      { email: "bob@initech.test", name: "Bob", initials: "B" },                        // asked before sources existed
      { email: "zed@initech.test", name: "Zed", initials: "Z" },                        // asked through Zendesk
      { email: "mia@initech.test", name: "Mia", initials: "M", notifyRoadmap: false }, // roadmap emails off, Shipped emails on
      { email: "fay@initech.test", name: "Fay", initials: "F" },                        // follows only
      { email: "sam@slack.invalid", name: "Sam", initials: "S" },                       // follows, no real address
    ].map(p => ({ ...p, workspaceId: ws!.id, accountId: acct!.id }))).returning({ id: accountUsers.id, email: accountUsers.email });
    const id = Object.fromEntries(people.map(p => [p.email.split("@")[0]!, p.id]));
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dark mode", status: "shipped" })
      .returning({ id: initiatives.id });
    await db.insert(items).values([
      { submitterId: id.ann!, seq: 1, shortId: "FB-1", title: "Dark theme please", source: "widget" },
      { submitterId: id.bob!, seq: 2, shortId: "FB-2", title: "Night mode", source: null },
      { submitterId: id.zed!, seq: 3, shortId: "FB-3", title: "Dark UI", source: "zendesk" },
      { submitterId: id.mia!, seq: 4, shortId: "FB-4", title: "Easier on the eyes", source: "widget" },
    ].map(i => ({ ...i, workspaceId: ws!.id, accountId: acct!.id, initiativeId: ini!.id, type: "idea" })));
    await db.insert(roadmapFollows).values(
      [id.ann!, id.fay!, id.sam!].map(accountUserId => ({ workspaceId: ws!.id, initiativeId: ini!.id, accountUserId })),
    );
    const [entry, manual] = await db.insert(changelogEntries).values([
      { workspaceId: ws!.id, initiativeId: ini!.id, title: "Dark mode is here", body: "Find it under Settings." },
      { workspaceId: ws!.id, title: "Faster search", body: "" },
    ]).returning({ id: changelogEntries.id });

    // What the prompt and the confirm count.
    const skipped = { count: 3, sources: ["zendesk"], noEmail: true, muted: true };
    expect(await announcementAudience(ws!.id, ini!.id)).toEqual({ reach: 3, followers: 0, alreadyHeard: 0, skipped, emailOn: true, openItems: 4 });

    const r = await publishChangelogEntry(ws!, entry!.id, {
      origin: "https://crumb.test",
      markShipped: { workspaceId: ws!.id, actorWorkspaceUserId: pm!.id, role: "admin" },
    });
    expect(r).toEqual({ ok: true, announced: true, delivered: 3, failed: 0, followers: 0, skipped, emailOn: true, marked: 4 });
    if (!r.ok) return;
    expect(publishedMessage(r)).toBe(
      "Sent to 3 customers. Marked 4 requests Shipped. 3 can't be emailed: they came in through Zendesk, have no email address, or turned updates off.",
    );

    // One email each: the announcement, or Mia's usual Shipped email about her
    // own request. None for Zed (Zendesk) or Sam (no address).
    expect(Object.fromEntries(h.sent.map(m => [m.to, m.subject]))).toEqual({
      "ann@initech.test": "Shipped: Dark mode is here",
      "bob@initech.test": "Shipped: Dark mode is here",
      "fay@initech.test": "Shipped: Dark mode is here",
      "mia@initech.test": "Shipped: Easier on the eyes",
    });
    expect(h.sent).toHaveLength(4);

    // Every request shipped, and the ledger says whose loops closed by email.
    const statuses = await db.select({ status: items.status }).from(items).where(eq(items.workspaceId, ws!.id));
    expect(statuses.map(s => s.status)).toEqual(["shipped", "shipped", "shipped", "shipped"]);
    const told = await db
      .select({ shortId: items.shortId, kind: customerNotifications.kind, toStatus: customerNotifications.toStatus })
      .from(customerNotifications)
      .innerJoin(items, eq(items.id, customerNotifications.itemId))
      .where(eq(items.workspaceId, ws!.id));
    expect(told.sort((a, b) => a.shortId.localeCompare(b.shortId))).toEqual([
      { shortId: "FB-1", kind: "status", toStatus: "shipped" },
      { shortId: "FB-2", kind: "status", toStatus: "shipped" },
      { shortId: "FB-4", kind: "status", toStatus: "shipped" },
    ]);

    // Publishing twice sends nothing more; a hand-written entry emails no one.
    expect(await publishChangelogEntry(ws!, entry!.id)).toEqual({ ok: false, error: "already_decided" });
    const plain = await publishChangelogEntry(ws!, manual!.id);
    expect(plain).toEqual({ ok: true, announced: false, followers: 0 });
    if (plain.ok) expect(publishedMessage(plain)).toBe("Published to your changelog.");
    expect(h.sent).toHaveLength(4);
  });

  it("never sends a second Shipped email about a merged request, and falls back when the announcement fails", async () => {
    h.sent.length = 0;
    const [ws] = await db.insert(workspaces)
      .values({ slug: `announce-${randomUUID().slice(0, 8)}`, name: "Acme" })
      .returning();
    created.push(ws!.id);
    const [pm] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws!.id, email: "pat@acme.test", name: "Pat", initials: "P", role: "admin" })
      .returning({ id: workspaceUsers.id });
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const people = await db.insert(accountUsers).values([
      { email: "ann@initech.test", name: "Ann", initials: "A" }, // asked, and asked again (merged)
      { email: "fay@initech.test", name: "Fay", initials: "F" }, // follows; her request was merged
      { email: "liv@initech.test", name: "Liv", initials: "L" }, // asked; the provider turns her announcement down
      { email: "qin@initech.test", name: "Qin", initials: "Q" }, // only a merged request, not in the audience
    ].map(p => ({ ...p, workspaceId: ws!.id, accountId: acct!.id }))).returning({ id: accountUsers.id, email: accountUsers.email });
    const id = Object.fromEntries(people.map(p => [p.email.split("@")[0]!, p.id]));
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dark mode", status: "shipped" })
      .returning({ id: initiatives.id });
    const base = { workspaceId: ws!.id, accountId: acct!.id, type: "idea", source: "widget" };
    const [canonical] = await db.insert(items)
      .values({ ...base, submitterId: id.ann!, seq: 1, shortId: "FB-1", title: "Dark theme please", initiativeId: ini!.id })
      .returning({ id: items.id });
    await db.insert(items)
      .values({ ...base, submitterId: id.liv!, seq: 5, shortId: "FB-5", title: "Dim the lights", initiativeId: ini!.id });
    const dup = { ...base, status: "duplicate", mergedIntoId: canonical!.id };
    await db.insert(items).values([
      { ...dup, submitterId: id.ann!, seq: 2, shortId: "FB-2", title: "Dark theme, again" },
      { ...dup, submitterId: id.fay!, seq: 3, shortId: "FB-3", title: "Night theme" },
      { ...dup, submitterId: id.qin!, seq: 4, shortId: "FB-4", title: "Black background" },
    ]);
    await db.insert(roadmapFollows).values({ workspaceId: ws!.id, initiativeId: ini!.id, accountUserId: id.fay! });
    const [entry] = await db.insert(changelogEntries)
      .values({ workspaceId: ws!.id, initiativeId: ini!.id, title: "Dark mode is here", body: "Find it under Settings." })
      .returning({ id: changelogEntries.id });
    h.reject.add("liv@initech.test Shipped: Dark mode is here");

    const r = await publishChangelogEntry(ws!, entry!.id, {
      origin: "https://crumb.test",
      markShipped: { workspaceId: ws!.id, actorWorkspaceUserId: pm!.id, role: "admin" },
    });
    expect(r).toMatchObject({ ok: true, announced: true, delivered: 2, failed: 1, marked: 2 });

    // One email each. Ann and Fay heard it in the announcement, so the merged
    // requests send nothing more; Liv gets her usual Shipped email instead of
    // the announcement that failed; Qin hears about her own merged request.
    expect(Object.fromEntries(h.sent.map(m => [m.to, m.subject]))).toEqual({
      "ann@initech.test": "Shipped: Dark mode is here",
      "fay@initech.test": "Shipped: Dark mode is here",
      "liv@initech.test": "Shipped: Dim the lights",
      "qin@initech.test": "Shipped: Black background",
    });
    expect(h.sent).toHaveLength(4);
  });

  it("drafts a private initiative's entry as private, a public one's as public", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `draft-vis-${randomUUID().slice(0, 8)}`, name: "Acme" })
      .returning();
    created.push(ws!.id);
    const [priv, pub] = await db.insert(initiatives).values([
      { workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Internal billing rework", status: "shipped", isPublic: false },
      { workspaceId: ws!.id, seq: 2, shortId: "IN-2", name: "Dark mode", status: "shipped", isPublic: true },
    ]).returning({ id: initiatives.id });
    expect((await draftChangelogForInitiative(ws!, priv!.id))?.isPublic).toBe(false);
    expect((await draftChangelogForInitiative(ws!, pub!.id))?.isPublic).toBe(true);
  });

  it("upgrades private initiatives' entries to private, and leaves the rest alone", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `backfill-${randomUUID().slice(0, 8)}`, name: "Acme" })
      .returning();
    created.push(ws!.id);
    const [globex, sso, dark] = await db.insert(initiatives).values([
      { workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dedicated DB for Globex", status: "shipped", isPublic: false },
      { workspaceId: ws!.id, seq: 2, shortId: "IN-2", name: "SSO for Globex", status: "shipped", isPublic: false },
      { workspaceId: ws!.id, seq: 3, shortId: "IN-3", name: "Dark mode", status: "shipped", isPublic: true },
    ]).returning({ id: initiatives.id });
    // Public, whatever the initiative, as drafting used to write them.
    await db.insert(changelogEntries).values([
      { workspaceId: ws!.id, initiativeId: globex!.id, title: "Dedicated DB for Globex", publishedAt: new Date() },
      { workspaceId: ws!.id, initiativeId: sso!.id, title: "SSO for Globex" }, // a draft
      { workspaceId: ws!.id, initiativeId: dark!.id, title: "Dark mode", publishedAt: new Date() },
      { workspaceId: ws!.id, title: "Faster search", publishedAt: new Date() },
    ]);

    // The migration spans every workspace, so it runs in a transaction that
    // rolls back: other tests' rows stay as they are.
    const backfill = readFileSync(resolve(__dirname, "../../../../packages/db/drizzle/0032_private_initiative_changelog_private.sql"), "utf8");
    let after: Record<string, boolean> = {};
    await db.transaction(async tx => {
      await tx.execute(sql.raw(backfill));
      const rows = await tx
        .select({ title: changelogEntries.title, isPublic: changelogEntries.isPublic })
        .from(changelogEntries)
        .where(eq(changelogEntries.workspaceId, ws!.id));
      after = Object.fromEntries(rows.map(r => [r.title, r.isPublic]));
      tx.rollback();
    }).catch((err: unknown) => { if (!(err instanceof TransactionRollbackError)) throw err; });
    expect(after).toEqual({ "Dedicated DB for Globex": false, "SSO for Globex": false, "Dark mode": true, "Faster search": true });
  });
});
