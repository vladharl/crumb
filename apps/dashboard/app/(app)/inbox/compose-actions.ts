"use server";

import { revalidatePath } from "next/cache";
import { getActiveSession } from "@/lib/server";
import { composeItem } from "@/lib/compose";

export type ComposeResult =
  | { ok: true; shortId: string }
  | { ok: false; error: string };

// Dashboard Compose panel — create an item on behalf of a customer. Thin
// wrapper over the session-free `composeItem` (lib/compose.ts), which is also
// reused by captures-accept and the Slack slash command.
export async function composeOnBehalf(input: {
  accountName: string;
  submitterEmail: string;
  submitterName?: string;
  type: string;
  title: string;
  body?: string;
}): Promise<ComposeResult> {
  const { workspace } = await getActiveSession();
  const r = await composeItem({ workspaceId: workspace.id, ...input });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/inbox");
  return { ok: true, shortId: r.shortId };
}
