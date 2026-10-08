"use server";

import { revalidatePath } from "next/cache";
import { getActiveSession } from "@/lib/server";
import { deleteItems as deleteItemsCore, type DeleteMode } from "@/lib/items/delete";
import type { VendorRole } from "@/lib/items/mutations";
import { log } from "@/lib/log";

// Delete or mark as spam, by short id, for useDeleteItems (which calls this
// only once its Undo window is over). Admin only and scoped to the session's
// workspace; the rules live in the core (lib/items/delete.ts).
export async function deleteItems(
  shortIds: string[],
  mode: DeleteMode,
): Promise<{ ok: true; deleted: number; restored: number; blocked: number } | { ok: false; error: string }> {
  const { workspace, user } = await getActiveSession();
  try {
    const r = await deleteItemsCore(
      { workspaceId: workspace.id, actorWorkspaceUserId: user.id, role: user.role as VendorRole },
      { shortIds, mode },
    );
    // Items count everywhere: inbox, threads, accounts, initiatives, Insights.
    if (r.ok) revalidatePath("/", "layout");
    return r;
  } catch (err) {
    log.error("delete items failed", { scope: "crumb/items", err });
    return { ok: false, error: "delete_failed" };
  }
}
