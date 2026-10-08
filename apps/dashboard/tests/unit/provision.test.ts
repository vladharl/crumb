import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { createWorkspaceWithAdmin } from "@/lib/provision";

// A workspace and its first admin are made together or not at all, so a failed
// signup or self-host first run leaves nothing behind for a retry to trip on.
// Against Postgres (DATABASE_URL, migrated); skipped locally when no database
// answers, like samples.test.ts. (That file covers the success path.)

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const slug = `provision-${randomUUID().slice(0, 8)}`;

describe.skipIf(!reachable && !process.env.CI)("createWorkspaceWithAdmin", () => {
  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.slug, slug));
  });

  it("leaves no workspace behind when its admin can't be created", async () => {
    // Postgres refuses a NUL byte in text: the admin insert fails after the workspace's.
    await expect(createWorkspaceWithAdmin({
      name: "Half made", slug, adminName: "Pat\u0000", adminEmail: "pat@example.test",
    })).rejects.toThrow();
    expect(await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug))).toEqual([]);
  });
});
