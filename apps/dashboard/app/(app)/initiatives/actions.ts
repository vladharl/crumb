"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, initiatives, workspaces, items, workspaceUsers, initiativeSuggestions } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { suggestInitiative, clusterConfigured, CLUSTER_MODEL } from "@/lib/ai/cluster";

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
  return { ok: true, id: created.id, shortId: created.shortId };
}

export async function updateInitiative(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: string;
    color?: string | null;
    ownerWorkspaceUserId?: string | null;
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
  for (const it of eligible) {
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
