import "server-only";
import { eq } from "drizzle-orm";
import { db, roadmapFollows, accountUsers, type Workspace } from "@crumb/db";
import { sendRoadmapUpdateNotification } from "./email";
import { notifyAccountChannels } from "./notify/account-channel";
import { log } from "./log";

// Email everyone following an initiative that it changed on the public
// roadmap. Best-effort, fire-and-forget — never blocks the vendor's edit.
export async function notifyRoadmapFollowers(
  workspace: Pick<Workspace, "name" | "productUrl" | "accent">,
  initiativeId: string,
  initiativeName: string,
  change: string,
  origin: string | null,
): Promise<void> {
  try {
    const followers = await db
      .select({
        id: accountUsers.id,
        accountId: accountUsers.accountId,
        email: accountUsers.email,
        notifyRoadmap: accountUsers.notifyRoadmap,
        unsubscribedAll: accountUsers.unsubscribedAll,
        unsubToken: accountUsers.unsubToken,
      })
      .from(roadmapFollows)
      .innerJoin(accountUsers, eq(accountUsers.id, roadmapFollows.accountUserId))
      .where(eq(roadmapFollows.initiativeId, initiativeId));
    // Honor each follower's prefs (skip if muted or roadmap updates are off).
    const recipients = followers.filter(f => !f.unsubscribedAll && f.notifyRoadmap);
    if (recipients.length === 0) return;
    await Promise.all(recipients.map(f => sendRoadmapUpdateNotification({
      to: f.email,
      workspaceName: workspace.name,
      initiativeName,
      change,
      productUrl: workspace.productUrl,
      accent: workspace.accent,
      unsubscribeUrl: origin ? `${origin}/api/v1/unsubscribe?u=${f.id}&t=${f.unsubToken}&scope=roadmap` : null,
    })));

    // Customer-side chat: one card per distinct account that has a follower.
    const accountIds = Array.from(new Set(recipients.map(f => f.accountId)));
    for (const accountId of accountIds) {
      void notifyAccountChannels(accountId, {
        kind: "roadmap_update",
        initiativeName,
        change,
        url: workspace.productUrl ?? null,
      }, "roadmap");
    }
  } catch (err) {
    log.error("roadmap follower notify failed", { scope: "crumb/roadmap", err });
  }
}
