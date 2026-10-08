import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, initiatives, workspaces } from "@crumb/db";
import { TOOLS, type ToolCtx } from "@/lib/mcp/tools";

// MCP list_roadmap reads like the board: Shipped is a status, not a column, so
// a shipped initiative is listed under shipped (newest first), never under the
// column it shipped from. Against Postgres (DATABASE_URL, migrated); skipped
// locally when no database answers.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("MCP list_roadmap", () => {
  let wsId = "";

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `roadmap-${randomUUID().slice(0, 8)}`, name: "Roadmap test" })
      .returning({ id: workspaces.id });
    wsId = ws.id;
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    await db.insert(initiatives).values([
      { seq: 1, shortId: "IN-1", name: "Now, second", roadmapColumn: "now", roadmapOrder: 1 },
      { seq: 2, shortId: "IN-2", name: "Shipped from Now", roadmapColumn: "now", roadmapOrder: 0, status: "shipped", updatedAt: daysAgo(30) },
      { seq: 3, shortId: "IN-3", name: "Shipped from Later", roadmapColumn: "later", roadmapOrder: 0, status: "shipped", updatedAt: daysAgo(1) },
      { seq: 4, shortId: "IN-4", name: "Next", roadmapColumn: "next" },
      { seq: 5, shortId: "IN-5", name: "Unscheduled", roadmapColumn: null },
    ].map(r => ({ workspaceId: wsId, ...r })));
  });

  afterAll(async () => {
    if (wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("lists shipped initiatives under shipped, not their old column", async () => {
    const tool = TOOLS.find(t => t.name === "list_roadmap")!;
    const lanes = (await tool.handler({}, { workspaceId: wsId } as ToolCtx)) as Record<string, Array<{ short_id: string }>>;
    const ids = Object.fromEntries(Object.entries(lanes).map(([k, rows]) => [k, rows.map(r => r.short_id)]));
    expect(ids).toEqual({ now: ["IN-1"], next: ["IN-4"], later: [], shipped: ["IN-3", "IN-2"], unscheduled: ["IN-5"] });
  });
});
