import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, statusEvents, workspaces } from "@crumb/db";
import { qbrActivity } from "@/app/qbr/activity";

// The QBR's "Shipped" counts requests moved to Shipped in the last 90 days,
// not shipped ones touched lately: a customer's thanks on something shipped
// last year bumps updated_at but isn't this quarter's work. Against Postgres
// (DATABASE_URL, migrated); skipped locally when no database answers.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("QBR activity", () => {
  let wsId = "";
  const day = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * day);

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `qbr-${randomUUID().slice(0, 8)}`, name: "QBR test" })
      .returning({ id: workspaces.id });
    wsId = ws.id;
    const [acct] = await db.insert(accounts).values({ workspaceId: wsId, name: "Acme" }).returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: wsId, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });

    // [short id, status now, created, shipped at (null = never), merged]
    const specs: Array<[string, string, number, number | null, boolean]> = [
      ["FB-1", "shipped", 400, 380, false], // shipped last year, replied to today
      ["FB-2", "shipped", 60, 10, false],   // shipped this quarter
      ["FB-3", "open", 60, 20, false],      // shipped, then reopened
      ["FB-4", "shipped", 30, 5, true],     // a merged duplicate
      ["FB-5", "planned", 10, null, false],
    ];
    let canonical: string | null = null;
    for (const [i, [shortId, status, created, shipped, merged]] of specs.entries()) {
      const [row]: Array<{ id: string }> = await db.insert(items).values({
        workspaceId: wsId, accountId: acct.id, submitterId: pat.id, seq: i + 1, shortId, title: shortId, type: "idea",
        status, createdAt: ago(created), updatedAt: new Date(), mergedIntoId: merged ? canonical : null,
      }).returning({ id: items.id });
      canonical ??= row.id;
      if (shipped !== null) {
        await db.insert(statusEvents).values({ itemId: row.id, fromStatus: "open", toStatus: "shipped", at: ago(shipped) });
      }
      if (status === "open" && shipped !== null) {
        await db.insert(statusEvents).values({ itemId: row.id, fromStatus: "shipped", toStatus: "open", at: ago(shipped - 1) });
      }
    }
  });

  afterAll(async () => {
    if (!wsId) return;
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("counts what shipped in the window, not what was touched in it", async () => {
    expect(await qbrActivity(wsId)).toEqual({ new_90: 3, shipped_90: 1, open_now: 2 });
  });
});
