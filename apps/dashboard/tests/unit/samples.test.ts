import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, initiatives, items, replies, workspaces } from "@crumb/db";
import { createWorkspaceWithAdmin } from "@/lib/provision";
import { hasSampleData } from "@/lib/samples";
import { loopTurn } from "@/lib/loop";
import { clearSampleData } from "@/app/(app)/settings/sample-actions";

// Sample data: a new Cloud workspace starts with a small sample set covering
// each loop state, self-host starts empty, and Settings' clear removes exactly
// the sample rows. Runs against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`) with the session mocked. Skipped locally when no database
// answers; CI has one, so there it fails instead of skipping.

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireSession }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const tag = randomUUID().slice(0, 8);
const created: string[] = [];

async function provision(tier: "cloud" | "self_host"): Promise<string> {
  vi.stubEnv("CRUMB_TIER", tier);
  const out = await createWorkspaceWithAdmin({
    name: "Samples test", slug: `samples-${tag}-${created.length}`, adminName: "Pat Admin", adminEmail: "pat@example.test",
  });
  created.push(out!.workspace.id);
  return out!.workspace.id;
}

// A real customer + item, optionally in an initiative.
async function addRealItem(workspaceId: string, initiativeId: string | null) {
  const [acct] = await db.insert(accounts).values({ workspaceId, name: "Acme" }).returning({ id: accounts.id });
  const [pat] = await db.insert(accountUsers)
    .values({ workspaceId, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id });
  const [item] = await db.insert(items).values({
    workspaceId, accountId: acct.id, submitterId: pat.id, initiativeId, seq: 6, shortId: "FB-6", title: "Real", type: "bug",
  }).returning({ id: items.id });
  return { accountId: acct.id, itemId: item.id };
}

const ids = async <T extends { id: unknown }>(rows: Promise<T[]>) => (await rows).map(r => r.id);
const initiativeIn = (workspaceId: string, shortId: string) =>
  db.select({ id: initiatives.id }).from(initiatives)
    .where(and(eq(initiatives.workspaceId, workspaceId), eq(initiatives.shortId, shortId)));

describe.skipIf(!reachable && !process.env.CI)("sample data", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("seeds a new Cloud workspace with every loop state, never emailable; self-host starts empty", async () => {
    const ws = await provision("cloud");
    expect(await hasSampleData(ws)).toBe(true);

    const rows = await db.select({ id: items.id, status: items.status }).from(items).where(eq(items.workspaceId, ws));
    const thread = await db.select({ itemId: replies.itemId, vendor: replies.workspaceUserId })
      .from(replies).innerJoin(items, eq(items.id, replies.itemId))
      .where(eq(items.workspaceId, ws)).orderBy(replies.createdAt);
    const lastSide = new Map(thread.map(r => [r.itemId, r.vendor ? "vendor" as const : "customer" as const]));
    expect(new Set(rows.map(r => loopTurn({ status: r.status, lastReplySide: lastSide.get(r.id) ?? null }))))
      .toEqual(new Set(["yours", "waiting", "closed"]));

    // The next real item and initiative carry on after the samples.
    const [counters] = await db.select({ item: workspaces.nextItemSeq, initiative: workspaces.nextInitiativeSeq })
      .from(workspaces).where(eq(workspaces.id, ws));
    expect(counters).toEqual({ item: rows.length + 1, initiative: 2 });

    const people = await db.select({ email: accountUsers.email, unsub: accountUsers.unsubscribedAll })
      .from(accountUsers).where(eq(accountUsers.workspaceId, ws));
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) expect(p.email.endsWith(".invalid") && p.unsub).toBe(true);

    const selfHost = await provision("self_host");
    expect(await hasSampleData(selfHost)).toBe(false);
    expect(await ids(db.select({ id: items.id }).from(items).where(eq(items.workspaceId, selfHost)))).toEqual([]);
  });

  it("clear is admin only and removes exactly the sample rows of the session's workspace", async () => {
    const a = await provision("cloud");
    const b = await provision("cloud");
    // A: a real item in a real initiative. B: a real item joins the sample initiative.
    const [realInitiative] = await db.insert(initiatives)
      .values({ workspaceId: a, seq: 2, shortId: "IN-2", name: "Real" }).returning({ id: initiatives.id });
    const realA = await addRealItem(a, realInitiative.id);
    const [sampleInitiativeB] = await initiativeIn(b, "IN-1");
    const realB = await addRealItem(b, sampleInitiativeB.id);

    requireSession.mockResolvedValue({ workspace: { id: a }, user: { role: "pm" } });
    expect(await clearSampleData()).toEqual({ ok: false, error: "admin_only" });
    expect(await hasSampleData(a)).toBe(true);

    requireSession.mockResolvedValue({ workspace: { id: a }, user: { role: "admin" } });
    expect(await clearSampleData()).toEqual({ ok: true, removed: 5 });
    expect(await hasSampleData(a)).toBe(false);
    expect(await ids(db.select({ id: items.id }).from(items).where(eq(items.workspaceId, a)))).toEqual([realA.itemId]);
    expect(await ids(db.select({ id: accounts.id }).from(accounts).where(eq(accounts.workspaceId, a)))).toEqual([realA.accountId]);
    expect(await initiativeIn(a, "IN-1")).toEqual([]);
    expect(await ids(initiativeIn(a, "IN-2"))).toEqual([realInitiative.id]);

    // B was untouched by A's clear; its own clear keeps the initiative a real item joined.
    expect(await hasSampleData(b)).toBe(true);
    requireSession.mockResolvedValue({ workspace: { id: b }, user: { role: "admin" } });
    expect(await clearSampleData()).toEqual({ ok: true, removed: 5 });
    expect(await ids(initiativeIn(b, "IN-1"))).toEqual([sampleInitiativeB.id]);
    const [joined] = await db.select({ initiativeId: items.initiativeId }).from(items).where(eq(items.id, realB.itemId));
    expect(joined.initiativeId).toBe(sampleInitiativeB.id);

    // Nothing left to clear.
    expect(await clearSampleData()).toEqual({ ok: true, removed: 0 });
  });

  it("keeps the sample initiative once an admin has renamed it or made it public", async () => {
    for (const change of [{ name: "Exports v2" }, { isPublic: true }]) {
      const ws = await provision("cloud");
      await db.update(initiatives).set(change)
        .where(and(eq(initiatives.workspaceId, ws), eq(initiatives.shortId, "IN-1")));
      requireSession.mockResolvedValue({ workspace: { id: ws }, user: { role: "admin" } });
      expect(await clearSampleData()).toEqual({ ok: true, removed: 5 });
      expect(await initiativeIn(ws, "IN-1")).toHaveLength(1);
    }
  });
});
