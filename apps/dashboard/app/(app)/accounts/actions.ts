"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { getActiveSession } from "@/lib/server";

function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

// Set an account's ARR (in cents). Admin/PM only; workspace-scoped.
// `accounts.arrCents` is an integer column (≈ $21M ceiling), so we cap below
// the int max to avoid overflow.
const MAX_ARR_CENTS = 2_100_000_000; // ~$21M

export async function setAccountArr(
  accountId: string,
  arrCents: number,
): Promise<{ ok: true; arrCents: number } | { ok: false; error: string }> {
  if (!accountId || typeof accountId !== "string") return { ok: false, error: "no_id" };
  if (!Number.isFinite(arrCents) || arrCents < 0) return { ok: false, error: "bad_arr" };
  const cents = Math.min(Math.round(arrCents), MAX_ARR_CENTS);

  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  // Mark the ARR as manually curated so a later CRM sync (feature 1) won't
  // overwrite it — see lib/integrations/crm/sync.ts.
  const r = await db
    .update(accounts)
    .set({ arrCents: cents, arrSource: "manual" })
    .where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.id, accountId)))
    .returning({ id: accounts.id });
  if (r.length === 0) return { ok: false, error: "not_found" };

  revalidatePath(`/accounts/${accountId}`);
  revalidatePath("/accounts");
  return { ok: true, arrCents: cents };
}
