import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";

// Semantic duplicate detection (feature 4). Pure pgvector cosine-ANN over
// item_embeddings — no aistack call, so this module is bundle-safe and ships
// in BOTH editions. On self-host item_embeddings is empty (embeddings are
// Cloud-only), so every query simply returns no candidates. Embeddings are
// populated fire-and-forget at capture (see app/api/v1/items/route.ts).

export type DuplicateCandidate = {
  itemId: string;
  shortId: string;
  title: string;
  status: string;
  similarity: number; // cosine similarity 0..1
};

// Default cosine-similarity floor for "these are the same request". Tunable via
// env without a redeploy of the logic. 0.85 is conservative; tighten if noisy.
function defaultThreshold(): number {
  const v = Number(process.env.CRUMB_DEDUP_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.85;
}

type Row = { id: string; short_id: string; title: string; status: string; similarity: number };

// Nearest neighbours to `itemId`'s stored embedding, within the same workspace,
// excluding itself and anything already merged. Two-step (fetch target vector,
// then ANN with a constant query vector) so Postgres uses the HNSW index — a
// self-join wouldn't let it treat the vector as a planning constant.
export async function findDuplicateCandidates(opts: {
  workspaceId: string;
  itemId: string;
  limit?: number;
  threshold?: number;
}): Promise<DuplicateCandidate[]> {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const threshold = opts.threshold ?? defaultThreshold();

  const target = (await db.execute(sql`
    SELECT embedding::text AS embedding
    FROM item_embeddings
    WHERE item_id = ${opts.itemId} AND workspace_id = ${opts.workspaceId}
    LIMIT 1
  `)) as unknown as Array<{ embedding: string }>;
  if (!target.length) return [];
  const vec = target[0].embedding; // pgvector text form "[a,b,c]"

  const rows = (await db.execute(sql`
    SELECT i.id AS id, i.short_id AS short_id, i.title AS title, i.status AS status,
           1 - (e.embedding <=> ${vec}::vector) AS similarity
    FROM item_embeddings e
    JOIN items i ON i.id = e.item_id
    WHERE e.workspace_id = ${opts.workspaceId}
      AND e.item_id <> ${opts.itemId}
      AND i.merged_into_id IS NULL
      AND i.status <> 'duplicate'
    ORDER BY e.embedding <=> ${vec}::vector ASC
    LIMIT ${limit}
  `)) as unknown as Row[];

  return rows
    .map((r) => ({
      itemId: r.id,
      shortId: r.short_id,
      title: r.title,
      status: r.status,
      similarity: Number(r.similarity),
    }))
    .filter((c) => Number.isFinite(c.similarity) && c.similarity >= threshold);
}
