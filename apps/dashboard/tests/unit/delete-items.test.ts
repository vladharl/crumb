import { afterAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db, accounts, accountUsers, attachments, inboundCaptures, items, replies, replayChunks, replaySessions,
  statusEvents, workspaces, workspaceUsers,
} from "@crumb/db";
import { deleteItems } from "@/lib/items/delete";
import { createItem, SubmitterBlockedError } from "@/lib/items/create";
import type { VendorRole } from "@/lib/items/mutations";
import { sign } from "@/lib/jwt";
import { signReplyToken } from "@/lib/reply-token";
import { buildInboxAddress } from "@/lib/inbound-address";
import { POST as widgetPost } from "@/app/api/v1/items/route";
import { POST as inboundReply } from "@/app/api/v1/inbound/reply/route";
import { POST as inboundEmail } from "@/app/api/v1/inbound/email/route";

// Delete and Mark as spam (audit #62): only the named items in the actor's
// workspace go, and only for an admin; requests merged into a deleted one go
// back to the status they had before the merge instead of reading Duplicate
// of nothing; the bytes behind deleted files and recordings are dropped; and
// spam blocks the submitter, whose next request is refused and whose emails
// are accepted and dropped.
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

const dropped = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  deleteBytes: async (key: string) => { dropped.push(key); },
}));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ slug: `delete-${randomUUID().slice(0, 8)}`, name: "Delete test" })
    .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
  created.push(ws!.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Acme" }).returning({ id: accounts.id });
  const person = async (email: string) => (await db.insert(accountUsers)
    .values({ workspaceId: ws!.id, accountId: acct!.id, email, name: email.split("@")[0]!, initials: "X" })
    .returning({ id: accountUsers.id }))[0]!.id;
  const member = async (role: VendorRole) => (await db.insert(workspaceUsers)
    .values({ workspaceId: ws!.id, email: `${role}@vendor.test`, name: role, initials: "V", role })
    .returning({ id: workspaceUsers.id }))[0]!.id;
  const item = async (submitterId: string, fields: Partial<typeof items.$inferInsert> = {}) => {
    const seq = fields.seq ?? randomInt(1_000_000, 2_000_000_000);
    return (await db.insert(items)
      .values({ workspaceId: ws!.id, accountId: acct!.id, submitterId, seq, shortId: `FB-${seq}`, title: "Export breaks", type: "bug", ...fields })
      .returning({ id: items.id, shortId: items.shortId, seq: items.seq }))[0]!;
  };
  const actor = (actorWorkspaceUserId: string, role: VendorRole) => ({ workspaceId: ws!.id, actorWorkspaceUserId, role });
  return { ...ws!, accountId: acct!.id, person, member, item, actor };
}

describe.skipIf(!reachable && !process.env.CI)("Delete and Mark as spam", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("deletes only the named items in this workspace, and unmerges what was merged into them", async () => {
    const a = await workspace();
    const admin = await a.member("admin");
    const pm = await a.member("pm");
    const pat = await a.person("pat@acme.test");
    const lee = await a.person("lee@acme.test");
    const kim = await a.person("kim@acme.test");
    const canonical = await a.item(pat, { status: "planned" });
    const kept = await a.item(pat);
    // Merged in the thread while In progress...
    const merged = await a.item(lee, { status: "duplicate", mergedIntoId: canonical.id, mergedAt: new Date() });
    const t = Date.now();
    await db.insert(statusEvents).values([
      { itemId: merged.id, fromStatus: null, toStatus: "open", at: new Date(t - 3_000) },
      { itemId: merged.id, fromStatus: "open", toStatus: "in_progress", at: new Date(t - 2_000) },
      { itemId: merged.id, fromStatus: "in_progress", toStatus: "duplicate", reason: `Merged into ${canonical.shortId}`, at: new Date(t - 1_000) },
    ]);
    // ...and folded in by Autopilot, which writes no event.
    const folded = await a.item(kim, { status: "duplicate", mergedIntoId: canonical.id });
    await db.insert(statusEvents).values({ itemId: folded.id, fromStatus: null, toStatus: "open" });

    // The canonical's files: an attachment, its own customer's recording, and
    // lee's, which the merge moved onto it.
    const [reply] = await db.insert(replies).values({ itemId: canonical.id, accountUserId: pat, body: "Screenshot" }).returning({ id: replies.id });
    await db.insert(attachments).values({
      replyId: reply!.id, filename: "shot.png", contentType: "image/png", sizeBytes: 10,
      storageKey: `t/${canonical.id}/shot`, uploadedByAccountUserId: pat,
    });
    const recording = async (accountUserId: string, key: string) => {
      const [s] = await db.insert(replaySessions)
        .values({ workspaceId: a.id, accountUserId, itemId: canonical.id, sessionToken: randomUUID().replace(/-/g, "") })
        .returning({ id: replaySessions.id });
      await db.insert(replayChunks).values({ sessionId: s!.id, sequence: 0, storageKey: key, sizeBytes: 10, eventCount: 1, startedAt: new Date(), endedAt: new Date() });
      return s!.id;
    };
    const patRecording = await recording(pat, `t/${canonical.id}/pat`);
    const leeRecording = await recording(lee, `t/${canonical.id}/lee`);

    // Another workspace's item with the same FB number.
    const b = await workspace();
    const elsewhere = await b.item(await b.person("pat@acme.test"), { seq: canonical.seq });

    expect(await deleteItems(a.actor(pm, "pm"), { shortIds: [canonical.shortId], mode: "delete" }))
      .toEqual({ ok: false, error: "admin_only" });
    expect(await deleteItems(a.actor(admin, "admin"), { shortIds: [canonical.shortId, canonical.shortId, "FB-0"], mode: "delete" }))
      .toEqual({ ok: true, deleted: 1, restored: 2, blocked: 0 });

    const rows = await db.select({ id: items.id, status: items.status, mergedIntoId: items.mergedIntoId }).from(items)
      .where(inArray(items.id, [canonical.id, kept.id, merged.id, folded.id, elsewhere.id]));
    expect(Object.fromEntries(rows.map(r => [r.id, [r.status, r.mergedIntoId]]))).toEqual({
      [kept.id]: ["open", null],
      [merged.id]: ["in_progress", null],
      [folded.id]: ["open", null],
      [elsewhere.id]: ["open", null],
    });
    expect(await db.select({ id: replies.id }).from(replies).where(eq(replies.itemId, canonical.id))).toEqual([]);
    const unmerged = await db.select({ itemId: statusEvents.itemId, from: statusEvents.fromStatus, to: statusEvents.toStatus, reason: statusEvents.reason })
      .from(statusEvents).where(eq(statusEvents.byWorkspaceUserId, admin));
    expect(unmerged).toEqual(expect.arrayContaining([
      { itemId: merged.id, from: "duplicate", to: "in_progress", reason: "Unmerged" },
      { itemId: folded.id, from: "duplicate", to: "open", reason: "Unmerged" },
    ]));
    expect(unmerged).toHaveLength(2);

    // Lee's recording went back with lee's request; the rest went, bytes too.
    const sessions = await db.select({ id: replaySessions.id, itemId: replaySessions.itemId }).from(replaySessions)
      .where(inArray(replaySessions.id, [patRecording, leeRecording]));
    expect(sessions).toEqual([{ id: leeRecording, itemId: merged.id }]);
    await vi.waitFor(() => expect(dropped.filter(k => k.startsWith(`t/${canonical.id}/`)).sort())
      .toEqual([`t/${canonical.id}/pat`, `t/${canonical.id}/shot`]));

    const [submitter] = await db.select({ blockedAt: accountUsers.blockedAt }).from(accountUsers).where(eq(accountUsers.id, pat));
    expect(submitter!.blockedAt).toBeNull();
  });

  it("marks as spam: blocks the submitter, refuses their next request and drops their emails", async () => {
    vi.stubEnv("CRUMB_INBOUND_SECRET", "inbound-test-secret");
    const a = await workspace();
    const admin = await a.member("admin");
    const spammer = await a.person("spam@junk.test");
    const junk = await a.item(spammer, { title: "Cheap watches" });
    const left = await a.item(spammer, { title: "More watches" });

    expect(await deleteItems(a.actor(admin, "admin"), { shortIds: [junk.shortId], mode: "spam" }))
      .toEqual({ ok: true, deleted: 1, restored: 0, blocked: 1 });
    const [person] = await db.select({ blockedAt: accountUsers.blockedAt }).from(accountUsers).where(eq(accountUsers.id, spammer));
    expect(person!.blockedAt).toBeInstanceOf(Date);

    // Refused before anything is written, so no FB number is used up.
    const seqOf = async () => (await db.select({ next: workspaces.nextItemSeq }).from(workspaces).where(eq(workspaces.id, a.id)))[0]!.next;
    const seq = await seqOf();
    await expect(createItem({
      workspaceId: a.id, accountId: a.accountId, accountName: "Acme", submitterId: spammer, submitterName: "spam", type: "idea", title: "Buy now",
    })).rejects.toBeInstanceOf(SubmitterBlockedError);
    expect(await seqOf()).toBe(seq);

    // The widget gets a plain refusal.
    const jwt = sign({ iss: a.slug, sub: "spam@junk.test", account_name: "Acme", exp: Math.floor(Date.now() / 1000) + 300 }, a.secret);
    const res = await widgetPost(new Request("http://localhost/api/v1/items", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ type: "idea", title: "Buy now" }),
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "submitter_blocked", message: "We can't accept feedback from you here." });

    // Their email reply and their forwarded email are accepted and dropped.
    const post = async (route: (req: Request) => Promise<Response>, body: object) => {
      const r = await route(new Request("http://localhost/api/v1/inbound", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer inbound-test-secret" },
        body: JSON.stringify(body),
      }));
      expect(r.status).toBe(200);
      return r.json();
    };
    expect(await post(inboundReply, {
      to: `reply+${left.shortId}.${signReplyToken(left.shortId, a.secret)}@reply.crumb.test`,
      from: "Spam <SPAM@junk.test>", text: "Buy now", message_id: "<s1@junk.test>",
    })).toEqual({ ok: true, accepted: false, reason: "blocked" });
    expect(await post(inboundEmail, {
      to: buildInboxAddress(a.slug, "crumb.test"), from: "spam@junk.test", subject: "Deal", text: "Buy now", message_id: "<s2@junk.test>",
    })).toEqual({ ok: true, accepted: false, reason: "blocked" });
    expect(await db.select({ id: replies.id }).from(replies).where(eq(replies.itemId, left.id))).toEqual([]);
    expect(await db.select({ id: inboundCaptures.id }).from(inboundCaptures).where(eq(inboundCaptures.workspaceId, a.id))).toEqual([]);
  });
});
