import "server-only";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db, items, accountUsers, attachments, replies, replayChunks, replaySessions, statusEvents } from "@crumb/db";
import { deleteBytes } from "@/lib/storage";
import { log } from "@/lib/log";
import type { VendorActor } from "@/lib/items/mutations";

// Delete and Mark as spam (admins only): test and spam requests otherwise skew
// ARR, Insights and every count until the workspace itself is deleted.
// Session-free, like the cores in mutations.ts; the server action
// (app/(app)/items/delete-actions.ts) resolves the session.
//
// A hard delete. Everything hanging off an item cascades with it (replies and
// their attachments and mentions, status events, the loop ledger, tags,
// embeddings, AI suggestions, replay sessions). Three foreign keys set null
// instead: inbound_captures.created_item_id and duplicate_of_item_id, which
// only lose their link (an accepted capture keeps its row, so Autopilot never
// re-ingests the record), and items.merged_into_id, which would strand every
// request merged into a deleted one as Duplicate of nothing. Those are
// restored first: back to the status they had before the merge, unmerged.
// Spam also blocks each item's submitter (account_users.blocked_at): createItem
// then refuses their new requests, and their email replies and forwarded
// emails are dropped. Nobody is emailed.

export type DeleteMode = "delete" | "spam";

// One selection's worth: the inbox bulk cap, and errorMessage's "Select up to 50".
const DELETE_MAX = 50;

export async function deleteItems(
  actor: VendorActor,
  input: { shortIds: string[]; mode: DeleteMode },
): Promise<{ ok: true; deleted: number; restored: number; blocked: number } | { ok: false; error: string }> {
  const { shortIds, mode } = input;
  if (actor.role !== "admin") return { ok: false, error: "admin_only" };
  if (mode !== "delete" && mode !== "spam") return { ok: false, error: "bad_mode" };
  if (!Array.isArray(shortIds) || shortIds.length === 0 || !shortIds.every(s => typeof s === "string")) {
    return { ok: false, error: "no_items" };
  }
  const wanted = [...new Set(shortIds)];
  if (wanted.length > DELETE_MAX) return { ok: false, error: "too_many_items" };

  const done = await db.transaction(async (tx) => {
    const targets = await tx
      .select({ id: items.id, shortId: items.shortId, submitterId: items.submitterId })
      .from(items)
      .where(and(eq(items.workspaceId, actor.workspaceId), inArray(items.shortId, wanted)));
    if (targets.length === 0) return null;
    const ids = targets.map(t => t.id);
    const now = new Date();

    // Requests merged into a deleted item, which aren't being deleted too.
    const merged = await tx
      .select({
        id: items.id,
        status: items.status,
        // Its status before the merge: its latest move to anything but
        // Duplicate (an Autopilot fold writes no event, so that's the opening
        // one). Raw qualified refs: drizzle would render ${items.id} unqualified.
        before: sql<string | null>`(
          SELECT se.to_status FROM status_events se
          WHERE se.item_id = items.id AND se.to_status <> 'duplicate'
          ORDER BY se.at DESC
          LIMIT 1
        )`,
      })
      .from(items)
      .where(and(eq(items.workspaceId, actor.workspaceId), inArray(items.mergedIntoId, ids), notInArray(items.id, ids)));

    // The merges moved their customers' recordings onto the canonical. Each
    // goes back with its request instead of cascading away, attributed as
    // unmergeItem does (thread actions): to the group item its person filed
    // first after it started. One that rule can't place (it started after all
    // their items, as when the browser's clock runs ahead) goes to the last one
    // they filed, where unmerge would leave it on the canonical. Runs while
    // the groups are still whole.
    if (merged.length > 0) {
      const owner = sql`COALESCE(
        (SELECT g.id FROM items g
          WHERE (g.id = replay_sessions.item_id OR g.merged_into_id = replay_sessions.item_id)
            AND g.submitter_id = replay_sessions.account_user_id
            AND g.created_at >= replay_sessions.started_at
          ORDER BY g.created_at LIMIT 1),
        (SELECT g.id FROM items g
          WHERE (g.id = replay_sessions.item_id OR g.merged_into_id = replay_sessions.item_id)
            AND g.submitter_id = replay_sessions.account_user_id
          ORDER BY g.created_at DESC LIMIT 1)
      )`;
      await tx.update(replaySessions)
        .set({ itemId: owner })
        .where(and(inArray(replaySessions.itemId, ids), inArray(owner, merged.map(m => m.id))));
    }

    for (const m of merged) {
      const status = m.before ?? "open";
      await tx.update(items)
        .set({ status, mergedIntoId: null, mergedAt: null, mergedByWorkspaceUserId: null, updatedAt: now })
        .where(eq(items.id, m.id));
      if (status !== m.status) {
        await tx.insert(statusEvents).values({
          itemId: m.id, fromStatus: m.status, toStatus: status, reason: "Unmerged", byWorkspaceUserId: actor.actorWorkspaceUserId,
        });
      }
    }

    const blocked = mode === "spam"
      ? await tx.update(accountUsers)
        .set({ blockedAt: now })
        .where(and(
          eq(accountUsers.workspaceId, actor.workspaceId),
          inArray(accountUsers.id, [...new Set(targets.map(t => t.submitterId))]),
          isNull(accountUsers.blockedAt),
        ))
        .returning({ id: accountUsers.id })
      : [];

    // The bytes behind its files and recordings, which no row will point to.
    const files = await tx.select({ key: attachments.storageKey }).from(attachments)
      .innerJoin(replies, eq(replies.id, attachments.replyId))
      .where(inArray(replies.itemId, ids));
    const chunks = await tx.select({ key: replayChunks.storageKey }).from(replayChunks)
      .innerJoin(replaySessions, eq(replaySessions.id, replayChunks.sessionId))
      .where(inArray(replaySessions.itemId, ids));

    await tx.delete(items).where(inArray(items.id, ids));
    return { targets, merged, blocked, keys: [...files, ...chunks].map(r => r.key) };
  });
  if (!done) return { ok: true, deleted: 0, restored: 0, blocked: 0 };

  // Who deleted what: ids and counts, never customer text.
  log.info("items deleted", {
    scope: "crumb/items",
    workspaceId: actor.workspaceId,
    byWorkspaceUserId: actor.actorWorkspaceUserId,
    mode,
    deleted: done.targets.length,
    itemIds: done.targets.map(t => t.id),
    shortIds: done.targets.map(t => t.shortId),
    restoredItemIds: done.merged.map(m => m.id),
    blockedAccountUserIds: done.blocked.map(b => b.id),
  });

  // Best-effort once the rows are gone, like the sweeps: a failed delete
  // leaves an orphan blob, never a row pointing at missing bytes. Not
  // awaited, so a long recording doesn't hold the request.
  void (async () => {
    let failed = 0;
    for (const key of done.keys) await deleteBytes(key).catch(() => { failed++; });
    if (failed) log.warn("deleted items left files in storage", { scope: "crumb/items", workspaceId: actor.workspaceId, failed });
  })();

  return { ok: true, deleted: done.targets.length, restored: done.merged.length, blocked: done.blocked.length };
}

// Whether `email` is a submitter whose feedback was marked as spam here. The
// inbound email routes drop what such an address sends.
export async function isBlockedSender(workspaceId: string, email: string | null): Promise<boolean> {
  if (!email) return false;
  const [row] = await db
    .select({ id: accountUsers.id })
    .from(accountUsers)
    .where(and(
      eq(accountUsers.workspaceId, workspaceId),
      sql`lower(${accountUsers.email}) = ${email.trim().toLowerCase()}`,
      isNotNull(accountUsers.blockedAt),
    ))
    .limit(1);
  return !!row;
}
