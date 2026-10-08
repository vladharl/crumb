import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, inboxViews, workspaces, workspaceUsers } from "@crumb/db";

// Saved inbox views are personal: stored as the canonical view string, saved
// again under the same name to update, deletable only by their owner. Runs
// against Postgres (DATABASE_URL, migrated); the session is faked.

const h = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/server", () => ({
  getActiveSession: async () => ({ workspace: { id: "unused" }, user: { id: h.userId, role: "viewer" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { deleteInboxView, saveInboxView } from "@/app/(app)/inbox/views-actions";

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("saved inbox views", () => {
  let workspaceId: string | null = null;
  afterAll(async () => {
    if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("saves the canonical view, updates it by name, and only its owner deletes it", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `views-${randomUUID().slice(0, 8)}`, name: "Views test" })
      .returning({ id: workspaces.id });
    workspaceId = ws.id;
    const [me, other] = await db.insert(workspaceUsers).values([
      { workspaceId: ws.id, email: "me@views.test", name: "Me", initials: "ME", role: "viewer" },
      { workspaceId: ws.id, email: "other@views.test", name: "Other", initials: "OT", role: "admin" },
    ]).returning({ id: workspaceUsers.id });
    h.userId = me!.id;

    const saved = await saveInboxView("  Bugs  ", "?type=bug&compose=1&tab=all");
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.view).toMatchObject({ name: "Bugs", query: "tab=all&type=bug" });

    const again = await saveInboxView("Bugs", "type=bug&q=export");
    if (!again.ok) throw new Error(again.error);
    expect(again.view).toEqual({ id: saved.view.id, name: "Bugs", query: "type=bug&q=export" });

    expect(await saveInboxView("   ", "type=bug")).toEqual({ ok: false, error: "name_required" });
    expect(await saveInboxView("x".repeat(61), "type=bug")).toEqual({ ok: false, error: "name_too_long" });
    expect(await saveInboxView("Default", "tab=yours&sort=newest")).toMatchObject({ ok: false });

    h.userId = other!.id;
    expect(await deleteInboxView(saved.view.id)).toEqual({ ok: false, error: "not_found" });
    h.userId = me!.id;
    expect(await deleteInboxView(saved.view.id)).toEqual({ ok: true });
    expect(await db.select().from(inboxViews).where(eq(inboxViews.workspaceUserId, me!.id))).toHaveLength(0);
  });
});
