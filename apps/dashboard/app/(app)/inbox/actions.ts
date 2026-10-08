"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { db, items } from "@crumb/db";
import { REASON_REQUIRED, VENDOR_STATUSES, type VendorStatus } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { assignItemTo, updateItemStatus, type VendorActor, type VendorRole } from "@/lib/items/mutations";
import { notifyAssignedMany } from "@/lib/vendor-notify";
import { log } from "@/lib/log";

// Status changes + assignment are manage actions — viewers are read-only.
function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

function actorOf(workspaceId: string, user: { id: string; role: string }): VendorActor {
  return { workspaceId, actorWorkspaceUserId: user.id, role: user.role as VendorRole };
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
const BULK_CONCURRENCY = 4;

// ponytail: a few items at a time, so a full selection finishes in one request
// without bursting the email provider's rate limit or the DB pool. Queue the
// work in a background job if selections need to grow past BULK_STATUS_MAX.
async function pooled<T>(list: T[], fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

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

  const actor = actorOf(ws.id, user);
  const origin = originFromHeaders(headers());
  let affected = 0;
  let failed = ids.length - rows.length;
  let firstError: string | undefined = failed > 0 ? "not_found" : undefined;
  await pooled(rows, async ({ shortId }) => {
    const r = await updateItemStatus(actor, { itemShortId: shortId, status: status as VendorStatus, reason: why, origin })
      .catch((err: unknown) => {
        log.error("bulk status update failed", { scope: "crumb/inbox", shortId, err });
        return { ok: false as const, error: "update_failed" };
      });
    if (r.ok) affected++;
    else { failed++; firstError ??= r.error; }
  });

  revalidatePath("/inbox");
  return firstError ? { ok: true, affected, failed, firstError } : { ok: true, affected, failed };
}

// Each item goes through the same assignment core as the thread, so
// item.assigned fires exactly like a single change. The assignee hears once
// for the lot (notifyAssignedMany), and not at all with `notify: false` (the
// toast's Undo, which only puts owners back). Items already with that assignee
// count as affected without a re-announce; ids outside this workspace are skipped.
export async function bulkAssign(
  itemIds: string[],
  assigneeId: string | null,
  opts: { notify?: boolean } = {},
): Promise<BulkResult> {
  if (!validIds(itemIds)) return { ok: false, error: "no_items" };

  const { workspace: ws, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const rows = await db
    .select({ id: items.id, shortId: items.shortId, assigneeId: items.assigneeId })
    .from(items)
    .where(and(eq(items.workspaceId, ws.id), inArray(items.id, [...new Set(itemIds)])));

  const actor = actorOf(ws.id, user);
  let affected = rows.filter(r => r.assigneeId === assigneeId).length;
  let firstError: string | undefined;
  const moved: string[] = [];
  await pooled(rows.filter(r => r.assigneeId !== assigneeId), async ({ id, shortId }) => {
    const r = await assignItemTo(actor, { itemShortId: shortId, assigneeId }, { notify: false })
      .catch((err: unknown) => {
        log.error("bulk assign failed", { scope: "crumb/inbox", shortId, err });
        return { ok: false as const, error: "update_failed" };
      });
    if (r.ok) { affected++; moved.push(id); }
    else firstError ??= r.error;
  });
  if (assigneeId && opts.notify !== false) {
    void notifyAssignedMany({ workspaceId: ws.id, itemIds: moved, assigneeId, actorWorkspaceUserId: user.id });
  }

  revalidatePath("/inbox");
  // Nothing moved (an assignee who left the workspace fails every item): say why.
  if (affected === 0 && firstError) return { ok: false, error: firstError };
  return { ok: true, affected };
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
    .select({ shortId: items.shortId, suggested: items.aiSuggestedAssigneeId })
    .from(items)
    .where(and(eq(items.workspaceId, ws.id), eq(items.id, itemId)))
    .limit(1);
  if (!it) return { ok: false, error: "not_found" };
  if (!it.suggested) return { ok: false, error: "no_suggestion" };

  // Through the assignment core, so the new owner hears about it.
  const r = await assignItemTo(actorOf(ws.id, user), { itemShortId: it.shortId, assigneeId: it.suggested });
  if (!r.ok) return r;
  await db
    .update(items)
    .set({ aiSuggestedAssigneeId: null })
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
