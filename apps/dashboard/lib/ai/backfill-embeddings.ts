import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { db, items, itemEmbeddings, workspaces } from "@crumb/db";
import { embedBatch, embeddingsConfigured, EMBEDDINGS_MODEL, EMBEDDINGS_DIM } from "@/lib/ai/embeddings";
import { withAiBudget } from "@/lib/ai/run";
import { hasFeature } from "@/lib/entitlements";
import { log } from "@/lib/log";

// Catch-up embeddings. An item with no item_embeddings row never shows up in
// dedup or Similar items: everything captured before a workspace gained AI (an
// upgrade), or whose capture-time embedding failed. Embeddings only, no triage.
// Newest first, at most `limit` items per run, sent to the embedder in batches.
// Run for every AI-entitled workspace by the daily digest cron
// (api/v1/internal/digest), and once by the Stripe webhook when a plan change
// grants AI. Safe to `void`: never throws.
//
// Budget: it counts against the workspace's monthly AI allowance (the "ai"
// metric, via withAiBudget), one unit per batch request, since one request is
// one inference call and that is what the meter counts. A run stops when the
// allowance is spent or the embedder fails a whole batch; the next day's run
// carries on from there.

const BACKFILL_LIMIT = 500;
const BATCH = 32;
// ponytail: inputs are cut to ~2k tokens so one huge body (MCP bodies are
// uncapped) can't fail its whole batch run after run. Raise it if the
// embedder's context allows.
const MAX_CHARS = 8_000;

export async function backfillEmbeddings(workspaceId: string, limit = BACKFILL_LIMIT): Promise<{ embedded: number }> {
  let embedded = 0;
  try {
    if (!embeddingsConfigured()) return { embedded };
    const [ws] = await db
      .select({ id: workspaces.id, planId: workspaces.planId, subscriptionStatus: workspaces.subscriptionStatus })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws || !hasFeature(ws, "ai")) return { embedded };

    // Duplicates are skipped: dedup never offers them as candidates.
    const missing = await db
      .select({ id: items.id, title: items.title, body: items.body })
      .from(items)
      .leftJoin(itemEmbeddings, eq(itemEmbeddings.itemId, items.id))
      .where(and(
        eq(items.workspaceId, workspaceId),
        isNull(itemEmbeddings.itemId),
        isNull(items.mergedIntoId),
        ne(items.status, "duplicate"),
      ))
      .orderBy(desc(items.createdAt))
      .limit(limit);

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      // Same text as the capture-time embedding (lib/items/create.ts).
      const texts = batch.map((it) => `${it.title}\n\n${it.body}`);
      const res = await withAiBudget(ws, () => embedBatch(texts.map((t) => t.slice(0, MAX_CHARS))));
      if (!res.ok || res.value.every((v) => !v)) break;
      const rows = batch.flatMap((it, j) => {
        const embedding = res.value[j];
        if (!embedding) return [];
        const contentHash = createHash("sha256").update(texts[j]).digest("hex");
        return [{ itemId: it.id, workspaceId, embedding, model: EMBEDDINGS_MODEL, dim: EMBEDDINGS_DIM, contentHash }];
      });
      // A capture-time embedding written meanwhile wins.
      const inserted = await db
        .insert(itemEmbeddings)
        .values(rows)
        .onConflictDoNothing()
        .returning({ itemId: itemEmbeddings.itemId });
      embedded += inserted.length;
    }
  } catch (err) {
    log.error("backfillEmbeddings failed", { scope: "crumb/ai", workspaceId, err });
  }
  return { embedded };
}

// The daily cron's pass: every AI-entitled workspace, one at a time.
export async function backfillAllEmbeddings(limit = BACKFILL_LIMIT): Promise<{ workspaces: number; embedded: number }> {
  const out = { workspaces: 0, embedded: 0 };
  if (!embeddingsConfigured()) return out;
  const all = await db
    .select({ id: workspaces.id, planId: workspaces.planId, subscriptionStatus: workspaces.subscriptionStatus })
    .from(workspaces);
  for (const ws of all) {
    if (!hasFeature(ws, "ai")) continue;
    out.workspaces++;
    out.embedded += (await backfillEmbeddings(ws.id, limit)).embedded;
  }
  return out;
}
