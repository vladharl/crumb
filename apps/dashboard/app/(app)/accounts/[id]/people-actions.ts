"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, accountUsers } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { log } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Take back a spam mark's block (account_users.blocked_at, set by Mark as spam
// in lib/items/delete.ts) once its Undo is gone: their new feedback and email
// replies are taken again. What was deleted stays deleted. Admin only, like
// the mark; scoped to the session's workspace.
export async function unblockPerson(accountUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false, error: "admin_only" };
  if (typeof accountUserId !== "string" || !UUID_RE.test(accountUserId)) return { ok: false, error: "not_found" };

  const [row] = await db
    .update(accountUsers)
    .set({ blockedAt: null })
    .where(and(eq(accountUsers.workspaceId, workspace.id), eq(accountUsers.id, accountUserId)))
    .returning({ accountId: accountUsers.accountId });
  if (!row) return { ok: false, error: "not_found" };

  log.info("submitter unblocked", { scope: "crumb/items", workspaceId: workspace.id, byWorkspaceUserId: user.id, accountUserId });
  revalidatePath(`/accounts/${row.accountId}`);
  return { ok: true };
}
