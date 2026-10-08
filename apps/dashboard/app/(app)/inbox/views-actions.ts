"use server";

import { revalidatePath } from "next/cache";
import { and, count, eq } from "drizzle-orm";
import { db, inboxViews } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { viewQuery } from "./view-query";

// Saved inbox views: a member's named filter + search combinations, stored as
// the canonical query string (viewQuery), so opening one is just a URL. They
// are personal, so viewers can keep them too.

export type SavedView = { id: string; name: string; query: string };

const NAME_MAX = 60;
const VIEWS_MAX = 50;

// Saving under a name you already use updates that view.
export async function saveInboxView(
  name: string,
  query: string,
): Promise<{ ok: true; view: SavedView } | { ok: false; error: string }> {
  const label = typeof name === "string" ? name.trim() : "";
  if (!label) return { ok: false, error: "name_required" };
  if (label.length > NAME_MAX) return { ok: false, error: "name_too_long" };
  const q = viewQuery(typeof query === "string" ? query : "");
  if (!q) return { ok: false, error: "Pick a tab, filter or search to save first." };

  const { user } = await getActiveSession();
  const mine = eq(inboxViews.workspaceUserId, user.id);
  const [[{ n }], [same]] = await Promise.all([
    db.select({ n: count() }).from(inboxViews).where(mine),
    db.select({ id: inboxViews.id }).from(inboxViews).where(and(mine, eq(inboxViews.name, label))).limit(1),
  ]);
  if (!same && n >= VIEWS_MAX) return { ok: false, error: `You can keep up to ${VIEWS_MAX} views. Delete one first.` };

  const [view] = await db
    .insert(inboxViews)
    .values({ workspaceUserId: user.id, name: label, query: q })
    .onConflictDoUpdate({ target: [inboxViews.workspaceUserId, inboxViews.name], set: { query: q } })
    .returning({ id: inboxViews.id, name: inboxViews.name, query: inboxViews.query });

  revalidatePath("/inbox");
  return { ok: true, view: view! };
}

export async function deleteInboxView(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "not_found" };
  const { user } = await getActiveSession();
  const gone = await db
    .delete(inboxViews)
    .where(and(eq(inboxViews.id, id), eq(inboxViews.workspaceUserId, user.id)))
    .returning({ id: inboxViews.id });
  if (gone.length === 0) return { ok: false, error: "not_found" };
  revalidatePath("/inbox");
  return { ok: true };
}
