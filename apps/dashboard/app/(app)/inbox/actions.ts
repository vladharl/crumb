"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { db, items, workspaceUsers } from "@crumb/db";
import { REASON_REQUIRED, VENDOR_STATUSES, type VendorStatus } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { updateItemStatus, type VendorRole } from "@/lib/items/mutations";
import { log } from "@/lib/log";

// Status changes + assignment are manage actions — viewers are read-only.
function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

export type BulkResult = { ok: true; affected: number } | { ok: false; error: string };
export type BulkStatusResult =
  | { ok: true; affected: number; failed: number; firstError?: string }
  | { ok: false; error: string };

function validIds(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.length > 0 && ids.every(i => typeof i === "string");
}

// One status request runs each item's full pipeline, customer email included,
// so it stays small enough to finish inside a request.
const BULK_STATUS_MAX = 50;
const BULK_STATUS_CONCURRENCY = 4;

// Each item goes through the same status core as the thread, so a bulk change
// writes status_events, fires webhooks + chat cards and emails the customer
// exactly like a single one. Items already in `status` count as affected (the
// core no-ops without re-notifying); ids outside this workspace count as failed.
export async function bulkUpdateStatus(itemIds: string[], status: string, reason?: string): Promise<BulkStatusResult> {
  if (!validIds(itemIds)) return { ok: false, error: "no_items" };
  if (new Set(itemIds).size > BULK_STATUS_MAX) return { ok: false, error: "too_many_items" };
  if (!VENDOR_STATUSES.includes(status as VendorStatus)) return { ok: false, error: "bad_status" };
  const why = reason?.trim() || undefined;
  if (REASON_REQUIRED.has(status) && !why) return { ok: false, error: "reason_required" };

  const { workspace: ws, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const ids = [...new Set(itemIds)];
  const rows = await db
    .select({ shortId: items.shortId })
    .from(items)
    .where(and(eq(items.workspaceId, ws.id), inArray(items.id, ids)));

  const actor = { workspaceId: ws.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole };
  const origin = originFromHeaders(headers());
  let affected = 0;
  let failed = ids.length - rows.length;
  let firstError: string | undefined = failed > 0 ? "not_found" : undefined;
  // ponytail: a few items at a time, so a full selection finishes in one
  // request without bursting the email provider's rate limit. Queue the sends
  // in a background job if selections need to grow past BULK_STATUS_MAX.
  const queue = [...rows];
  await Promise.all(Array.from({ length: Math.min(BULK_STATUS_CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const { shortId } = row;
      const r = await updateItemStatus(actor, { itemShortId: shortId, status: status as VendorStatus, reason: why, origin })
        .catch((err: unknown) => {
          log.error("bulk status update failed", { scope: "crumb/inbox", shortId, err });
          return { ok: false as const, error: "update_failed" };
        });
      if (r.ok) affected++;
      else { failed++; firstError ??= r.error; }
    }
  }));

  revalidatePath("/inbox");
  return firstError ? { ok: true, affected, failed, firstError } : { ok: true, affected, failed };
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

export type ActionResult = { ok: true } | { ok: false; error: string };

// Accept the AI triage's suggested owner (feature 3): promote ai_suggested_
// assignee_id to the real assignee, then clear the suggestion so the chip
// disappears. The suggestion is advisory until a PM accepts here.
export async function acceptTriageAssignee(itemId: string): Promise<ActionResult> {
  if (typeof itemId !== "string" || !itemId) return { ok: false, error: "no_item" };
  const { workspace: ws, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const [it] = await db
    .select({ suggested: items.aiSuggestedAssigneeId })
    .from(items)
    .where(and(eq(items.workspaceId, ws.id), eq(items.id, itemId)))
    .limit(1);
  if (!it) return { ok: false, error: "not_found" };
  if (!it.suggested) return { ok: false, error: "no_suggestion" };

  await db
    .update(items)
    .set({ assigneeId: it.suggested, aiSuggestedAssigneeId: null, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, ws.id), eq(items.id, itemId)));

  revalidatePath("/inbox");
  return { ok: true };
}

// Dismiss the AI's suggested owner without assigning anyone.
export async function dismissTriage(itemId: string): Promise<ActionResult> {
  if (typeof itemId !== "string" || !itemId) return { ok: false, error: "no_item" };
  const { workspace: ws, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  await db
    .update(items)
    .set({ aiSuggestedAssigneeId: null, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, ws.id), eq(items.id, itemId)));

  revalidatePath("/inbox");
  return { ok: true };
}
