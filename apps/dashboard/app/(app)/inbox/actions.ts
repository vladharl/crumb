"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db, items, workspaceUsers } from "@crumb/db";
import { getActiveSession } from "@/lib/server";

// Status changes + assignment are manage actions — viewers are read-only.
function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

const ALLOWED_STATUSES = [
  "open", "review", "planned", "progress",
  "shipped", "declined", "deferred", "duplicate",
] as const;
type Status = (typeof ALLOWED_STATUSES)[number];

export type BulkResult = { ok: true; affected: number } | { ok: false; error: string };

function validIds(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.length > 0 && ids.every(i => typeof i === "string");
}

export async function bulkUpdateStatus(itemIds: string[], status: string): Promise<BulkResult> {
  if (!validIds(itemIds)) return { ok: false, error: "no_items" };
  if (!ALLOWED_STATUSES.includes(status as Status)) return { ok: false, error: "bad_status" };

  const { workspace: ws, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  const result = await db
    .update(items)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, ws.id), inArray(items.id, itemIds)))
    .returning({ id: items.id });

  revalidatePath("/inbox");
  return { ok: true, affected: result.length };
}

export async function bulkAssign(itemIds: string[], assigneeId: string | null): Promise<BulkResult> {
  if (!validIds(itemIds)) return { ok: false, error: "no_items" };

  const { workspace: ws, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  // If unassigning, no need to validate; otherwise confirm the assignee is in this workspace.
  if (assigneeId) {
    const [u] = await db
      .select({ id: workspaceUsers.id })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.workspaceId, ws.id), eq(workspaceUsers.id, assigneeId)))
      .limit(1);
    if (!u) return { ok: false, error: "bad_assignee" };
  }

  const result = await db
    .update(items)
    .set({ assigneeId, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, ws.id), inArray(items.id, itemIds)))
    .returning({ id: items.id });

  revalidatePath("/inbox");
  return { ok: true, affected: result.length };
}
