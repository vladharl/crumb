import { afterAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, replayChunks, replaySessions, workspaces, workspaceUsers } from "@crumb/db";
import { signReplyToken } from "@/lib/reply-token";

// Follow-ups to Delete and Mark as spam (audit #62): deleting a canonical
// hands each merged request back the recordings its merge brought along, by
// the attribution unmergeItem uses, and deleting a merged request takes its
// own off the canonical, bytes too; an emailed reply to a deleted item is
// accepted and dropped (a 200, so the provider doesn't retry), also on Cloud,
// where other workspaces have the same FB number; and an admin can take back
// a block that outlived its Undo.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const h = vi.hoisted(() => ({ session: null as unknown, dropped: [] as string[] }));
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  deleteBytes: async (key: string) => { h.dropped.push(key); },
}));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { deleteItems, isBlockedSender } from "@/lib/items/delete";
import { POST as inboundReply } from "@/app/api/v1/inbound/reply/route";
import { unblockPerson } from "@/app/(app)/accounts/[id]/people-actions";

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

async function workspace(nextItemSeq?: number) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `delete-followups-${randomUUID().slice(0, 8)}`, name: "Delete follow-ups", ...(nextItemSeq ? { nextItemSeq } : {}) })
    .returning({ id: workspaces.id, secret: workspaces.signingSecret });
  created.push(ws!.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
  const [admin] = await db.insert(workspaceUsers)
    .values({ workspaceId: ws!.id, email: "lina@vendor.test", name: "Lina", initials: "L", role: "admin" })
    .returning({ id: workspaceUsers.id });
  const person = async (name: string, blockedAt: Date | null = null) => (await db.insert(accountUsers)
    .values({ workspaceId: ws!.id, accountId: acct!.id, email: `${name.toLowerCase()}@initech.test`, name, initials: name[0]!, blockedAt })
    .returning({ id: accountUsers.id }))[0]!.id;
  const actor = { workspaceId: ws!.id, actorWorkspaceUserId: admin!.id, role: "admin" as const };
  return { id: ws!.id, secret: ws!.secret, accountId: acct!.id, adminId: admin!.id, actor, person };
}

describe.skipIf(!reachable && !process.env.CI)("Delete and Mark as spam follow-ups", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("hands each merged request back the recordings it brought, as unmerge would", async () => {
    const a = await workspace();
    const pat = await a.person("Pat");
    const lee = await a.person("Lee");
    // Filed a day apart, each from a session that started an hour before.
    // Pat's repeat and both of Lee's were merged into Pat's first, which
    // moved their sessions onto it.
    const day = 86_400_000;
    const t0 = Date.now() - 10 * day;
    const base = randomInt(1_000_000, 900_000_000);
    const sessionOf: Record<string, string> = {};
    const file = async (key: string, submitterId: string, d: number, canonicalId?: string) => {
      const createdAt = new Date(t0 + d * day);
      const [row] = await db.insert(items).values({
        workspaceId: a.id, accountId: a.accountId, submitterId, seq: base + d, shortId: `FB-${base + d}`, title: key, type: "idea", createdAt,
        ...(canonicalId ? { status: "duplicate", mergedIntoId: canonicalId, mergedAt: new Date() } : {}),
      }).returning({ id: items.id, shortId: items.shortId });
      const [s] = await db.insert(replaySessions).values({
        workspaceId: a.id, accountUserId: submitterId, itemId: canonicalId ?? row!.id,
        sessionToken: randomUUID().replace(/-/g, ""), startedAt: new Date(createdAt.getTime() - 3_600_000),
      }).returning({ id: replaySessions.id });
      sessionOf[key] = s!.id;
      return row!;
    };
    const canonical = await file("canonical", pat, 1);
    const lee1 = await file("lee1", lee, 2, canonical.id);
    const repeat = await file("repeat", pat, 3, canonical.id);
    const lee2 = await file("lee2", lee, 4, canonical.id);

    expect(await deleteItems(a.actor, { shortIds: [canonical.shortId], mode: "delete" }))
      .toEqual({ ok: true, deleted: 1, restored: 3, blocked: 0 });
    // Each went home, Lee's two apart; the canonical's own went with it.
    const left = await db.select({ id: replaySessions.id, itemId: replaySessions.itemId })
      .from(replaySessions).where(eq(replaySessions.workspaceId, a.id));
    expect(Object.fromEntries(left.map(s => [s.id, s.itemId]))).toEqual({
      [sessionOf.lee1!]: lee1.id,
      [sessionOf.repeat!]: repeat.id,
      [sessionOf.lee2!]: lee2.id,
    });
  });

  it("takes a deleted duplicate's own recordings off its canonical, bytes too", async () => {
    const a = await workspace();
    const pat = await a.person("Pat");
    const lee = await a.person("Lee");
    // Pat's request, and Lee's a day later, merged into it. Each came from a
    // recording that started an hour before; the merge moved Lee's onto Pat's.
    const day = 86_400_000;
    const t0 = Date.now() - 10 * day;
    const base = randomInt(1_000_000, 900_000_000);
    const file = async (submitterId: string, d: number, mergedIntoId?: string) => (await db.insert(items).values({
      workspaceId: a.id, accountId: a.accountId, submitterId, seq: base + d, shortId: `FB-${base + d}`, title: "Export", type: "idea",
      createdAt: new Date(t0 + d * day), ...(mergedIntoId ? { status: "duplicate", mergedIntoId, mergedAt: new Date() } : {}),
    }).returning({ id: items.id, shortId: items.shortId }))[0]!;
    const canonical = await file(pat, 0);
    const dup = await file(lee, 1, canonical.id);
    const recording = async (accountUserId: string, d: number) => {
      const [s] = await db.insert(replaySessions).values({
        workspaceId: a.id, accountUserId, itemId: canonical.id, sessionToken: randomUUID().replace(/-/g, ""),
        startedAt: new Date(t0 + d * day - 3_600_000),
      }).returning({ id: replaySessions.id });
      await db.insert(replayChunks).values({
        sessionId: s!.id, sequence: 0, storageKey: `t/${s!.id}`, sizeBytes: 10, eventCount: 1, startedAt: new Date(), endedAt: new Date(),
      });
      return s!.id;
    };
    const patRecording = await recording(pat, 0);
    const leeRecording = await recording(lee, 1);

    expect(await deleteItems(a.actor, { shortIds: [dup.shortId], mode: "delete" }))
      .toEqual({ ok: true, deleted: 1, restored: 0, blocked: 0 });
    expect(await db.select({ id: replaySessions.id, itemId: replaySessions.itemId })
      .from(replaySessions).where(eq(replaySessions.workspaceId, a.id)))
      .toEqual([{ id: patRecording, itemId: canonical.id }]);
    await vi.waitFor(() => expect(h.dropped).toContain(`t/${leeRecording}`));
    expect(h.dropped).not.toContain(`t/${patRecording}`);
  });

  it("accepts and drops an emailed reply to a deleted item, also where another workspace has its number", async () => {
    vi.stubEnv("CRUMB_INBOUND_SECRET", "");
    const seq = randomInt(1_000_000, 900_000_000);
    const shortId = `FB-${seq}`;
    // Both workspaces issued the number; one has since deleted its item.
    const a = await workspace(seq + 1);
    const b = await workspace(seq + 1);
    for (const w of [a, b]) {
      await db.insert(items).values({ workspaceId: w.id, accountId: w.accountId, submitterId: await w.person("Pat"), seq, shortId, title: "Export", type: "idea" });
    }
    expect(await deleteItems(a.actor, { shortIds: [shortId], mode: "delete" })).toMatchObject({ ok: true, deleted: 1 });

    const reply = async (id: string, secret: string) => {
      const res = await inboundReply(new Request("http://localhost/api/v1/inbound/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: `reply+${id}.${signReplyToken(id, secret)}@reply.crumb.test`,
          from: "Pat <pat@initech.test>", text: "Any news?", message_id: `<${randomUUID()}@initech.test>`,
        }),
      }));
      return [res.status, await res.json()];
    };
    expect(await reply(shortId, a.secret)).toEqual([200, { ok: true, accepted: false, reason: "item_deleted" }]);
    // A forged address is refused as before.
    expect(await reply(shortId, "not-a-workspace-secret")).toEqual([403, { error: "invalid_token" }]);
    expect(await reply(`FB-${seq + 1}`, a.secret)).toEqual([404, { error: "item_not_found" }]);
  });

  it("lets an admin unblock a person in their own workspace, and nobody else", async () => {
    const a = await workspace();
    const b = await workspace();
    const sam = await a.person("Sam", new Date());
    const elsewhere = await b.person("Sam", new Date());
    const blockedAt = async (id: string) =>
      (await db.select({ at: accountUsers.blockedAt }).from(accountUsers).where(eq(accountUsers.id, id)))[0]!.at;

    h.session = { workspace: { id: a.id }, user: { id: a.adminId, role: "pm" } };
    expect(await unblockPerson(sam)).toEqual({ ok: false, error: "admin_only" });
    h.session = { workspace: { id: a.id }, user: { id: a.adminId, role: "admin" } };
    expect(await unblockPerson(elsewhere)).toEqual({ ok: false, error: "not_found" });
    expect(await unblockPerson("not-a-uuid")).toEqual({ ok: false, error: "not_found" });
    expect(await blockedAt(sam)).toBeInstanceOf(Date);

    expect(await unblockPerson(sam)).toEqual({ ok: true });
    expect(await blockedAt(sam)).toBeNull();
    expect(await isBlockedSender(a.id, "sam@initech.test")).toBe(false);
    expect(await blockedAt(elsewhere)).toBeInstanceOf(Date);
  });
});
