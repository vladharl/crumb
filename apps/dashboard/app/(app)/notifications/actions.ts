"use server";

import { eq } from "drizzle-orm";
import { db, notificationPreferences, workspaceUsers } from "@crumb/db";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";

export type PrefsInput = {
  digestFrequency?: "off" | "daily" | "weekly";
  newSubmissionRealtime?: boolean;
  assignedRealtime?: boolean;
  replyRealtime?: boolean;
  mentionRealtime?: boolean;
  delivery?: "email" | "slack" | "none";
};

export type Result = { ok: true } | { ok: false; error: string };

const VALID_DIGEST = new Set(["off", "daily", "weekly"]);
const VALID_DELIVERY = new Set(["email", "slack", "none"]);

export async function markAllRead(): Promise<Result> {
  const { user } = await requireSession();
  await db
    .update(workspaceUsers)
    .set({ notificationsLastReadAt: new Date() })
    .where(eq(workspaceUsers.id, user.id));
  // Feed now lives in the top-bar bell (client-refetched); prefs live in settings.
  revalidatePath("/settings/notifications");
  return { ok: true };
}

export async function savePreferences(input: PrefsInput): Promise<Result> {
  const { user } = await requireSession();

  if (input.digestFrequency && !VALID_DIGEST.has(input.digestFrequency)) {
    return { ok: false, error: "Invalid digest frequency." };
  }
  if (input.delivery && !VALID_DELIVERY.has(input.delivery)) {
    return { ok: false, error: "Delivery must be email, slack, or none." };
  }

  // Upsert: insert defaults if no row exists, otherwise update the provided keys.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.digestFrequency !== undefined)       set.digestFrequency = input.digestFrequency;
  if (input.newSubmissionRealtime !== undefined) set.newSubmissionRealtime = input.newSubmissionRealtime;
  if (input.assignedRealtime !== undefined)      set.assignedRealtime = input.assignedRealtime;
  if (input.replyRealtime !== undefined)         set.replyRealtime = input.replyRealtime;
  if (input.mentionRealtime !== undefined)       set.mentionRealtime = input.mentionRealtime;
  if (input.delivery !== undefined)              set.delivery = input.delivery;

  await db
    .insert(notificationPreferences)
    // A first row keeps the default this member had without one: new-submission
    // alerts on for admins only (lib/vendor-notify.ts nudgeChannel).
    .values({ workspaceUserId: user.id, newSubmissionRealtime: user.role === "admin", ...set })
    .onConflictDoUpdate({
      target: notificationPreferences.workspaceUserId,
      set,
    });

  revalidatePath("/settings/notifications");
  return { ok: true };
}
