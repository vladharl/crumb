import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, workspaces } from "@crumb/db";
import { composeItem } from "@/lib/compose";

// Compose (and captures, Slack, MCP, Autopilot) find the customer's account by
// name ignoring case, so "acme co" lands in "Acme Co" instead of starting a
// second account. A submitter marked as spam gets a sentence back, not an
// exception, so none of those callers crash. Runs against Postgres (DATABASE_URL, migrated); skipped
// locally when no database answers, like compose-announce.test.ts.

vi.mock("@/lib/webhooks", () => ({ emitEvent: async () => {} }));
vi.mock("@/lib/notify/chat", () => ({ notifyWorkspaceChannel: async () => {} }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("composeItem account matching", () => {
  let workspaceId: string | null = null;
  afterAll(async () => {
    if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("lands a differently cased name in the existing account, prefers an exact twin, and answers a blocked submitter", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `acct-${randomUUID().slice(0, 8)}`, name: "Account match test" })
      .returning({ id: workspaces.id });
    workspaceId = ws.id;
    const base = { workspaceId: ws.id, type: "idea", title: "CSV export" };

    const first = await composeItem({ ...base, accountName: "Acme Co", submitterEmail: "maya@acme.test" });
    const second = await composeItem({ ...base, accountName: "  acme co ", submitterEmail: "sam@acme.test" });
    if (!first.ok || !second.ok) throw new Error("compose failed");
    expect(second.accountId).toBe(first.accountId);
    expect(second.accountName).toBe("Acme Co");
    const acme = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.workspaceId, ws.id));
    expect(acme).toHaveLength(1);

    // Near-twins left by the old case-sensitive match: the exact spelling
    // wins, otherwise the oldest.
    const [older] = await db.insert(accounts).values({ workspaceId: ws.id, name: "globex", createdAt: new Date(Date.now() - 60_000) }).returning();
    const [newer] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Globex" }).returning();
    const exact = await composeItem({ ...base, accountName: "Globex", submitterEmail: "ana@globex.test" });
    const other = await composeItem({ ...base, accountName: "GLOBEX", submitterEmail: "lee@globex.test" });
    if (!exact.ok || !other.ok) throw new Error("compose failed");
    expect(exact.accountId).toBe(newer!.id);
    expect(other.accountId).toBe(older!.id);

    await db.update(accountUsers).set({ blockedAt: new Date() })
      .where(and(eq(accountUsers.workspaceId, ws.id), eq(accountUsers.email, "maya@acme.test")));
    expect(await composeItem({ ...base, accountName: "Acme Co", submitterEmail: "maya@acme.test" }))
      .toEqual({ ok: false, error: expect.stringMatching(/marked as spam/) });
  });
});
