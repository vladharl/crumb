import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { db, initiatives, initiativeSuggestions } from "@crumb/db";
import type { Workspace } from "@crumb/db";
import { suggestInitiative, clusterConfigured, CLUSTER_MODEL } from "@/lib/ai/cluster";
import { hasFeature } from "@/lib/entitlements";
import { consumeAi } from "@/lib/usage";
import { log } from "@/lib/log";

type WorkspaceLite = Pick<Workspace, "id" | "planId" | "subscriptionStatus">;

/**
 * Fire-and-forget AI initiative suggestion for one item. Shared by every
 * item-creation path (widget API, captures accept, manual compose) so feedback
 * gets a suggestion the moment it's created, not only via the manual
 * "Cluster selected" button.
 *
 * Best-effort and idempotent: gated on the deployment capability + the
 * workspace's plan; skips if a pending suggestion already exists; consumes one
 * metered AI unit; swallows all errors. On self-host the cluster module is
 * stubbed (clusterConfigured() === false), so this no-ops and never pulls the
 * AI client into the community bundle.
 */
export async function autoClusterItem(
  ws: WorkspaceLite,
  item: { itemId: string; title: string; body: string; type: string },
): Promise<void> {
  try {
    if (!clusterConfigured() || !hasFeature(ws, "ai")) return;

    // Don't overwrite an in-flight guess (keeps this safe to call repeatedly).
    const [existing] = await db
      .select({ id: initiativeSuggestions.id })
      .from(initiativeSuggestions)
      .where(and(eq(initiativeSuggestions.itemId, item.itemId), eq(initiativeSuggestions.status, "pending")))
      .limit(1);
    if (existing) return;

    const candidates = await db
      .select({ id: initiatives.id, name: initiatives.name, description: initiatives.description })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws.id), ne(initiatives.status, "parked")));
    if (candidates.length === 0) return;

    const consumed = await consumeAi(ws);
    if (!consumed.ok) {
      log.warn("ai cap reached, skipping autoClusterItem", { scope: "crumb/ai", workspaceId: ws.id, cap: consumed.cap });
      return;
    }

    const guess = await suggestInitiative({ title: item.title, body: item.body, type: item.type }, candidates);
    if (!guess) return;

    await db.insert(initiativeSuggestions).values({
      itemId: item.itemId,
      initiativeId: guess.initiativeId,
      confidence: guess.confidence,
      reason: guess.reason,
      model: CLUSTER_MODEL,
    });
  } catch (err) {
    log.error("autoClusterItem failed", { scope: "crumb/ai", err });
  }
}
