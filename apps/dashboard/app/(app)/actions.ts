"use server";

import { eq } from "drizzle-orm";
import { db, workspaceUsers } from "@crumb/db";
import { requireSession } from "@/lib/auth";

/**
 * Stamps the current user's getting-started tour as finished. Called when the
 * first-sign-in walkthrough is completed, skipped, or relaunched. Idempotent —
 * re-stamping now() is harmless. No revalidatePath: the flag only changes the
 * next full layout render (the next sign-in), not the current session's UI.
 */
export async function completeTour(): Promise<{ ok: true }> {
  const { user } = await requireSession();
  await db
    .update(workspaceUsers)
    .set({ guideCompletedAt: new Date() })
    .where(eq(workspaceUsers.id, user.id));
  return { ok: true };
}
