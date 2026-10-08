"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db, changelogEntries } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { publishChangelogEntry, type PublishResult } from "@/lib/changelog";
import type { VendorRole } from "@/lib/items/mutations";

function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

export type ChangelogActionResult = { ok: true } | { ok: false; error: string };

const TITLE_MAX = 200;
const BODY_MAX = 8000;

export async function createChangelogEntry(input: {
  title: string;
  body?: string;
  isPublic?: boolean;
}): Promise<ChangelogActionResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  const title = input.title.trim().slice(0, TITLE_MAX);
  if (!title) return { ok: false, error: "title_required" };

  await db.insert(changelogEntries).values({
    workspaceId: workspace.id,
    title,
    body: (input.body ?? "").trim().slice(0, BODY_MAX),
    isPublic: input.isPublic ?? true,
    createdByWorkspaceUserId: user.id,
  });
  revalidatePath("/changelog");
  return { ok: true };
}

export async function updateChangelogEntry(
  id: string,
  patch: { title?: string; body?: string; isPublic?: boolean },
): Promise<ChangelogActionResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const t = patch.title.trim().slice(0, TITLE_MAX);
    if (!t) return { ok: false, error: "title_required" };
    updates.title = t;
  }
  if (patch.body !== undefined) updates.body = patch.body.trim().slice(0, BODY_MAX);
  if (patch.isPublic !== undefined) updates.isPublic = patch.isPublic;

  const r = await db
    .update(changelogEntries)
    .set(updates)
    .where(and(eq(changelogEntries.workspaceId, workspace.id), eq(changelogEntries.id, id)))
    .returning({ id: changelogEntries.id });
  if (r.length === 0) return { ok: false, error: "not_found" };
  revalidatePath("/changelog");
  return { ok: true };
}

// Publish. An initiative's entry is also emailed to everyone who asked or
// follows, and with markShipped its open requests move to Shipped. The result
// says who was actually reached (lib/changelog). Publishes once.
export async function publishEntry(id: string, opts: { markShipped?: boolean } = {}): Promise<PublishResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  const r = await publishChangelogEntry(workspace, id, {
    origin: originFromHeaders(headers()),
    markShipped: opts.markShipped
      ? { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole }
      : undefined,
  });
  if (!r.ok) return r;
  revalidatePath("/changelog");
  if (r.announced && r.marked > 0) {
    revalidatePath("/inbox");
    revalidatePath("/initiatives");
  }
  return r;
}

export async function deleteChangelogEntry(id: string): Promise<ChangelogActionResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };
  await db
    .delete(changelogEntries)
    .where(and(eq(changelogEntries.workspaceId, workspace.id), eq(changelogEntries.id, id)));
  revalidatePath("/changelog");
  return { ok: true };
}
