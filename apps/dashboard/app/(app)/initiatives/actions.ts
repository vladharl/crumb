"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, initiatives, workspaces, items, accounts, workspaceUsers, initiativeSuggestions } from "@crumb/db";
import type { Workspace } from "@crumb/db";
import { headers } from "next/headers";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { suggestInitiative, clusterConfigured, CLUSTER_MODEL } from "@/lib/ai/cluster";
import { autoClusterItem } from "@/lib/ai/auto-cluster";
import { aiCap, consumeAi } from "@/lib/usage";
import { notifyRoadmapFollowers } from "@/lib/roadmap-notify";
import { log } from "@/lib/log";

const ROADMAP_COLUMNS = new Set(["now", "next", "later"]);
const ROADMAP_COLUMN_LABEL: Record<string, string> = { now: "Now", next: "Next", later: "Later" };

const ALLOWED_STATUSES = ["open", "in_progress", "shipped", "parked"] as const;
type InitiativeStatus = (typeof ALLOWED_STATUSES)[number];

const NAME_MAX = 120;
const DESC_MAX = 4000;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export type ActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true } & T)
  | { ok: false; error: string };

function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

export async function createInitiative(input: {
  name: string;
  description?: string;
  status?: string;
  color?: string;
  ownerWorkspaceUserId?: string | null;
}): Promise<{ ok: true; id: string; shortId: string } | { ok: false; error: string }> {
  const name = input.name?.trim();
  if (!name) return { ok: false, error: "name_required" };
  if (name.length > NAME_MAX) return { ok: false, error: "name_too_long" };

  const description = input.description?.trim() || null;
  if (description && description.length > DESC_MAX) return { ok: false, error: "description_too_long" };

  const status = (input.status ?? "open") as InitiativeStatus;
  if (!ALLOWED_STATUSES.includes(status)) return { ok: false, error: "bad_status" };

  const color = input.color?.trim() || null;
  if (color && !HEX_RE.test(color)) return { ok: false, error: "bad_color" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  let ownerId: string | null = null;
  if (input.ownerWorkspaceUserId) {
    const [u] = await db
      .select({ id: workspaceUsers.id })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, input.ownerWorkspaceUserId)))
      .limit(1);
    if (!u) return { ok: false, error: "bad_owner" };
    ownerId = u.id;
  }

  // Atomically claim the next sequence number for this workspace.
  const [seqRow] = await db
    .update(workspaces)
    .set({ nextInitiativeSeq: sql`${workspaces.nextInitiativeSeq} + 1` })
    .where(eq(workspaces.id, workspace.id))
    .returning({ next: workspaces.nextInitiativeSeq });
  const seq = (seqRow?.next ?? 1) - 1;
  const shortId = `IN-${seq}`;

  const [created] = await db
    .insert(initiatives)
    .values({
      workspaceId: workspace.id,
      seq,
      shortId,
      name,
      description,
      status,
      color,
      ownerWorkspaceUserId: ownerId,
    })
    .returning({ id: initiatives.id, shortId: initiatives.shortId });

  revalidatePath("/initiatives");
  revalidatePath("/inbox");

  // Fire-and-forget: back-fill suggestions for existing unassigned feedback now
  // that there's a new bucket it might belong to. Best-effort, budget-bounded.
  void reclusterUnassigned(workspace);

  return { ok: true, id: created.id, shortId: created.shortId };
}

// Re-run AI clustering over the workspace's currently unassigned items (no
// initiative, no pending suggestion). Bounded to one batch; the per-item budget
// + dup guard inside autoClusterItem keep cost in check. Never throws.
async function reclusterUnassigned(ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">): Promise<void> {
  try {
    if (!clusterConfigured() || aiCap(ws) <= 0) return;
    const rows = await db
      .select({ id: items.id, title: items.title, body: items.body, type: items.type })
      .from(items)
      .where(and(eq(items.workspaceId, ws.id), isNull(items.initiativeId), isNull(items.mergedIntoId)))
      .limit(CLUSTER_BATCH_MAX);
    for (const it of rows) {
      await autoClusterItem(ws, { itemId: it.id, title: it.title, body: it.body, type: it.type });
    }
  } catch (err) {
    log.error("reclusterUnassigned failed", { scope: "crumb/ai", err });
  }
}

export async function updateInitiative(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: string;
    color?: string | null;
    ownerWorkspaceUserId?: string | null;
    trackedEventNames?: string[] | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id || typeof id !== "string") return { ok: false, error: "no_id" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { ok: false, error: "name_required" };
    if (name.length > NAME_MAX) return { ok: false, error: "name_too_long" };
    updates.name = name;
  }

  if (patch.description !== undefined) {
    const desc = patch.description?.trim() || null;
    if (desc && desc.length > DESC_MAX) return { ok: false, error: "description_too_long" };
    updates.description = desc;
  }

  if (patch.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(patch.status as InitiativeStatus)) {
      return { ok: false, error: "bad_status" };
    }
    updates.status = patch.status;
  }

  if (patch.color !== undefined) {
    const c = patch.color?.trim() || null;
    if (c && !HEX_RE.test(c)) return { ok: false, error: "bad_color" };
    updates.color = c;
  }

  if (patch.ownerWorkspaceUserId !== undefined) {
    if (patch.ownerWorkspaceUserId) {
      const [u] = await db
        .select({ id: workspaceUsers.id })
        .from(workspaceUsers)
        .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, patch.ownerWorkspaceUserId)))
        .limit(1);
      if (!u) return { ok: false, error: "bad_owner" };
      updates.ownerWorkspaceUserId = u.id;
    } else {
      updates.ownerWorkspaceUserId = null;
    }
  }

  if (patch.trackedEventNames !== undefined) {
    if (patch.trackedEventNames === null) {
      updates.trackedEventNames = null;
    } else {
      if (!Array.isArray(patch.trackedEventNames)) return { ok: false, error: "bad_events" };
      // Normalize: trim, drop empties, cap each name + the list, dedupe.
      const cleaned = Array.from(new Set(
        patch.trackedEventNames
          .filter((s): s is string => typeof s === "string")
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.slice(0, 64)),
      )).slice(0, 20);
      updates.trackedEventNames = cleaned.length ? cleaned : null;
    }
  }

  const r = await db
    .update(initiatives)
    .set(updates)
    .where(and(eq(initiatives.workspaceId, workspace.id), eq(initiatives.id, id)))
    .returning({ id: initiatives.id });
  if (r.length === 0) return { ok: false, error: "not_found" };

  revalidatePath("/initiatives");
  revalidatePath(`/initiatives/${id}`);
  revalidatePath("/inbox");
  return { ok: true };
}

export async function archiveInitiative(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  // Soft-stub: set status to 'parked'. v1 doesn't hard-delete; items keep
  // pointing at the row so the inbox column stays consistent.
  return updateInitiative(id, { status: "parked" });
}

export async function bulkSetInitiative(
  itemIds: string[],
  initiativeId: string | null,
): Promise<{ ok: true; affected: number } | { ok: false; error: string }> {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return { ok: false, error: "no_items" };
  if (!itemIds.every(i => typeof i === "string")) return { ok: false, error: "no_items" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  if (initiativeId) {
    const [row] = await db
      .select({ id: initiatives.id })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, workspace.id), eq(initiatives.id, initiativeId)))
      .limit(1);
    if (!row) return { ok: false, error: "bad_initiative" };
  }

  const result = await db
    .update(items)
    .set({ initiativeId, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, workspace.id), inArray(items.id, itemIds)))
    .returning({ id: items.id });

  revalidatePath("/inbox");
  if (initiativeId) revalidatePath(`/initiatives/${initiativeId}`);
  return { ok: true, affected: result.length };
}

// ─── Board: roadmap column placement + ordering ─────────────
// The Initiatives board (Now/Next/Later + Unscheduled) is the primary view.
// A drag persists the target column AND the new order for every card in that
// column via a single reorder call. Followers of a public initiative are
// notified when it lands in a new column.
export async function reorderInitiatives(
  column: string | null,
  orderedIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Array.isArray(orderedIds) || !orderedIds.every(i => typeof i === "string")) {
    return { ok: false, error: "bad_input" };
  }
  if (column !== null && !ROADMAP_COLUMNS.has(column)) return { ok: false, error: "bad_column" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  if (orderedIds.length === 0) return { ok: true };

  // Prior state, to detect public items that change column (for notify).
  const prev = await db
    .select({ id: initiatives.id, name: initiatives.name, isPublic: initiatives.isPublic, roadmapColumn: initiatives.roadmapColumn })
    .from(initiatives)
    .where(and(eq(initiatives.workspaceId, workspace.id), inArray(initiatives.id, orderedIds)));
  const prevById = new Map(prev.map(p => [p.id, p]));

  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .update(initiatives)
      .set({ roadmapColumn: column, roadmapOrder: i, updatedAt: new Date() })
      .where(and(eq(initiatives.workspaceId, workspace.id), eq(initiatives.id, orderedIds[i]!)));
  }

  revalidatePath("/initiatives");

  if (column) {
    const origin = originFromHeaders(headers());
    for (const id of orderedIds) {
      const p = prevById.get(id);
      if (p && p.isPublic && p.roadmapColumn !== column) {
        void notifyRoadmapFollowers(workspace, id, p.name, `moved to ${ROADMAP_COLUMN_LABEL[column]}`, origin);
      }
    }
  }
  return { ok: true };
}

export async function setInitiativePublic(
  initiativeId: string,
  isPublic: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  const r = await db
    .update(initiatives)
    .set({ isPublic })
    .where(and(eq(initiatives.workspaceId, workspace.id), eq(initiatives.id, initiativeId)))
    .returning({ id: initiatives.id });
  if (r.length === 0) return { ok: false, error: "not_found" };
  revalidatePath("/initiatives");
  return { ok: true };
}

// Candidate items for the "Add items" picker on an initiative page: items in
// this workspace not yet attached to any initiative. Capped; the client filters
// the returned set by title / short-id so typing doesn't round-trip per key.
export async function listUnassignedItems(): Promise<
  | { ok: true; items: Array<{ id: string; shortId: string; title: string; type: string; status: string; accountName: string }> }
  | { ok: false; error: string }
> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const rows = await db
    .select({
      id: items.id,
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      status: items.status,
      accountName: accounts.name,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(and(eq(items.workspaceId, workspace.id), isNull(items.initiativeId)))
    .orderBy(desc(items.updatedAt))
    .limit(200);

  return { ok: true, items: rows };
}

export async function setItemInitiative(
  itemShortId: string,
  initiativeId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!itemShortId) return { ok: false, error: "no_item" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  if (initiativeId) {
    const [row] = await db
      .select({ id: initiatives.id })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, workspace.id), eq(initiatives.id, initiativeId)))
      .limit(1);
    if (!row) return { ok: false, error: "bad_initiative" };
  }

  const r = await db
    .update(items)
    .set({ initiativeId, updatedAt: new Date() })
    .where(and(eq(items.workspaceId, workspace.id), eq(items.shortId, itemShortId)))
    .returning({ id: items.id });
  if (r.length === 0) return { ok: false, error: "not_found" };

  revalidatePath(`/thread/${itemShortId}`);
  revalidatePath("/inbox");
  if (initiativeId) revalidatePath(`/initiatives/${initiativeId}`);
  return { ok: true };
}

// ─── AI clustering ───────────────────────────────────────────

// Pick up to N items at a time when batching from the inbox. Keeps LLM
// cost predictable and the UI responsive — a vendor who selects 200 items
// gets the first 25 clustered; clicking again picks up the rest.
const CLUSTER_BATCH_MAX = 25;

export async function acceptSuggestion(suggestionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!suggestionId || typeof suggestionId !== "string") return { ok: false, error: "no_id" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  // Join through items to confirm the suggestion's item belongs to this
  // workspace. Prevents accepting another workspace's suggestion via guessed id.
  const [row] = await db
    .select({
      sId: initiativeSuggestions.id,
      itemId: initiativeSuggestions.itemId,
      itemShortId: items.shortId,
      initiativeId: initiativeSuggestions.initiativeId,
      status: initiativeSuggestions.status,
    })
    .from(initiativeSuggestions)
    .innerJoin(items, eq(items.id, initiativeSuggestions.itemId))
    .where(and(eq(initiativeSuggestions.id, suggestionId), eq(items.workspaceId, workspace.id)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "pending") return { ok: false, error: "already_decided" };

  await db
    .update(items)
    .set({ initiativeId: row.initiativeId, updatedAt: new Date() })
    .where(eq(items.id, row.itemId));
  await db
    .update(initiativeSuggestions)
    .set({ status: "accepted", decidedAt: new Date() })
    .where(eq(initiativeSuggestions.id, row.sId));

  revalidatePath("/inbox");
  revalidatePath(`/thread/${row.itemShortId}`);
  revalidatePath(`/initiatives/${row.initiativeId}`);
  return { ok: true };
}

export async function dismissSuggestion(suggestionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!suggestionId || typeof suggestionId !== "string") return { ok: false, error: "no_id" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const [row] = await db
    .select({
      sId: initiativeSuggestions.id,
      itemShortId: items.shortId,
      initiativeId: initiativeSuggestions.initiativeId,
      status: initiativeSuggestions.status,
    })
    .from(initiativeSuggestions)
    .innerJoin(items, eq(items.id, initiativeSuggestions.itemId))
    .where(and(eq(initiativeSuggestions.id, suggestionId), eq(items.workspaceId, workspace.id)))
    .limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "pending") return { ok: false, error: "already_decided" };

  await db
    .update(initiativeSuggestions)
    .set({ status: "dismissed", decidedAt: new Date() })
    .where(eq(initiativeSuggestions.id, row.sId));

  revalidatePath("/inbox");
  revalidatePath(`/thread/${row.itemShortId}`);
  revalidatePath(`/initiatives/${row.initiativeId}`);
  return { ok: true };
}

export async function clusterItems(itemIds: string[]): Promise<{ ok: true; suggested: number; skipped: number } | { ok: false; error: string }> {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return { ok: false, error: "no_items" };
  if (!itemIds.every(i => typeof i === "string")) return { ok: false, error: "no_items" };

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  if (!clusterConfigured()) return { ok: false, error: "not_configured" };

  // Plan-entitlement / cap gate. aiCap is 0 for plans without AI; per-item
  // budget is enforced atomically inside the loop via consumeAi.
  if (aiCap(workspace) <= 0) return { ok: false, error: "ai_cap_reached" };

  // Pull the candidates this workspace can be classified into. Parked
  // initiatives are excluded — clustering shouldn't suggest archived buckets.
  const initiativeRows = await db
    .select({ id: initiatives.id, name: initiatives.name, description: initiatives.description })
    .from(initiatives)
    .where(and(eq(initiatives.workspaceId, workspace.id), ne(initiatives.status, "parked")));
  if (initiativeRows.length === 0) return { ok: false, error: "no_initiatives" };

  // Workspace-scoped + only un-assigned items + cap to the batch limit.
  const eligible = await db
    .select({
      id: items.id,
      title: items.title,
      body: items.body,
      type: items.type,
    })
    .from(items)
    .where(and(
      eq(items.workspaceId, workspace.id),
      inArray(items.id, itemIds),
      isNull(items.initiativeId),
    ))
    .limit(CLUSTER_BATCH_MAX);

  let suggested = 0;
  let skipped = 0;
  for (let idx = 0; idx < eligible.length; idx++) {
    const it = eligible[idx]!;
    // Skip if this item already has a pending suggestion — don't burn
    // tokens to overwrite an in-flight guess.
    const [existing] = await db
      .select({ id: initiativeSuggestions.id })
      .from(initiativeSuggestions)
      .where(and(
        eq(initiativeSuggestions.itemId, it.id),
        eq(initiativeSuggestions.status, "pending"),
      ))
      .limit(1);
    if (existing) { skipped++; continue; }

    // Atomically consume one unit of monthly AI budget. Once exhausted, stop
    // and count the remaining items as skipped.
    if (!(await consumeAi(workspace)).ok) { skipped += eligible.length - idx; break; }

    const guess = await suggestInitiative(
      { title: it.title, body: it.body, type: it.type },
      initiativeRows.map(i => ({ id: i.id, name: i.name, description: i.description })),
    );
    if (!guess) { skipped++; continue; }

    await db.insert(initiativeSuggestions).values({
      itemId: it.id,
      initiativeId: guess.initiativeId,
      confidence: guess.confidence,
      reason: guess.reason,
      model: CLUSTER_MODEL,
    });
    suggested++;
  }

  revalidatePath("/inbox");
  return { ok: true, suggested, skipped: skipped + (itemIds.length - eligible.length) };
}
