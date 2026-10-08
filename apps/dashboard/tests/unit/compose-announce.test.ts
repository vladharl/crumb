import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { composeItem } from "@/lib/compose";

// A new item is announced (item.created webhook, Teams new-submission post),
// but an Autopilot duplicate isn't: it is folded into an existing item at once
// (lib/feedback/ingest.ts attachToCanonical passes announce: false).
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

const h = vi.hoisted(() => ({ announced: [] as string[] }));
vi.mock("@/lib/webhooks", () => ({
  emitEvent: async (_ws: string, e: { type: string }) => { h.announced.push(e.type); },
}));
vi.mock("@/lib/notify/chat", () => ({
  notifyWorkspaceChannel: async (_ws: string, n: { kind: string }) => { h.announced.push(n.kind); },
}));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("composeItem announcements", () => {
  let workspaceId: string | null = null;
  afterAll(async () => {
    if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("announces a new item, and stays quiet for one created as a duplicate", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `compose-${randomUUID().slice(0, 8)}`, name: "Compose test" })
      .returning({ id: workspaces.id });
    workspaceId = ws.id;
    const item = { workspaceId: ws.id, accountName: "Globex", submitterEmail: "maya@globex.test", type: "idea", title: "CSV export" };

    expect(await composeItem(item)).toMatchObject({ ok: true });
    expect(h.announced).toEqual(["item.created", "new_submission"]);

    h.announced.length = 0;
    expect(await composeItem({ ...item, announce: false })).toMatchObject({ ok: true });
    expect(h.announced).toEqual([]);
  });
});
