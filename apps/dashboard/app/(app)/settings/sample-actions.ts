"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { removeSampleData } from "@/lib/samples";
import { log } from "@/lib/log";

// Settings: clear the sample data a new Cloud workspace starts with. Admin
// only, scoped to the session's workspace. `removed` counts the sample items.
export async function clearSampleData(): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "admin_only" };

  try {
    const removed = await removeSampleData(workspace.id);
    // Samples show up everywhere: inbox, accounts, initiatives, Insights.
    revalidatePath("/", "layout");
    return { ok: true, removed };
  } catch (err) {
    log.error("clear sample data failed", { scope: "crumb/samples", err });
    return { ok: false, error: "clear_failed" };
  }
}
