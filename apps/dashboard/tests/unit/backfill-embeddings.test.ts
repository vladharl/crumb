import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, itemEmbeddings, items, usageCounters, workspaces } from "@crumb/db";
import { backfillEmbeddings } from "@/lib/ai/backfill-embeddings";

// A workspace that gains AI has items with no embedding, so they never show up
// in dedup or Similar items. The backfill embeds them newest first, capped per
// run, skips duplicates and items that already have one, meters one AI unit
// per batch request, and does nothing for a workspace without AI.
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

const h = vi.hoisted(() => ({ batches: [] as string[][] }));
vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDINGS_MODEL: "test-embed",
  EMBEDDINGS_DIM: 1024,
  embeddingsConfigured: () => true,
  embedBatch: async (texts: string[]) => {
    h.batches.push(texts);
    return texts.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)));
  },
}));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("backfillEmbeddings", () => {
  const wsIds: string[] = [];
  const ids: Record<string, string> = {};

  async function workspaceWithItems(planId: string, titles: string[]): Promise<string> {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `backfill-${randomUUID().slice(0, 8)}`, name: "Backfill", planId, subscriptionStatus: "active" })
      .returning({ id: workspaces.id });
    wsIds.push(ws.id);
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Globex" }).returning({ id: accounts.id });
    const [user] = await db.insert(accountUsers)
      .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@globex.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const now = Date.now();
    const rows = await db.insert(items).values(titles.map((title, i) => ({
      workspaceId: ws.id, accountId: acct.id, submitterId: user.id, seq: i + 1, shortId: `FB-${i + 1}`,
      title, body: "", type: "idea", createdAt: new Date(now + i * 1_000), // later in the list = newer
    }))).returning({ id: items.id, title: items.title });
    for (const r of rows) ids[r.title] = r.id;
    return ws.id;
  }

  beforeAll(() => { vi.stubEnv("CRUMB_TIER", "cloud"); });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const id of wsIds) {
      await db.delete(items).where(eq(items.workspaceId, id));
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }
  });

  it("embeds what's missing, newest first and capped per run, one AI unit per batch", async () => {
    const ws = await workspaceWithItems("team", ["oldest", "folded", "has one", "newest"]);
    await db.update(items).set({ mergedIntoId: ids.oldest, status: "duplicate" }).where(eq(items.id, ids.folded));
    await db.insert(itemEmbeddings).values({
      itemId: ids["has one"], workspaceId: ws, model: "earlier", embedding: Array.from({ length: 1024 }, () => 0.5),
    });

    expect(await backfillEmbeddings(ws, 1)).toEqual({ embedded: 1 });
    expect(h.batches).toEqual([["newest\n\n"]]);

    expect(await backfillEmbeddings(ws)).toEqual({ embedded: 1 });
    expect(h.batches[1]).toEqual(["oldest\n\n"]);
    expect(await backfillEmbeddings(ws)).toEqual({ embedded: 0 });
    expect(h.batches).toHaveLength(2);

    const [kept] = await db.select({ model: itemEmbeddings.model }).from(itemEmbeddings).where(eq(itemEmbeddings.itemId, ids["has one"]));
    expect(kept.model).toBe("earlier");
    const [used] = await db.select({ count: usageCounters.count }).from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, ws), eq(usageCounters.metric, "ai")));
    expect(used.count).toBe(2);
  });

  it("does nothing for a workspace without AI", async () => {
    h.batches.length = 0;
    const ws = await workspaceWithItems("free", ["no plan"]);
    expect(await backfillEmbeddings(ws)).toEqual({ embedded: 0 });
    expect(h.batches).toEqual([]);
  });
});
