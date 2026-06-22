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

// Nearest neighbours to an arbitrary query vector within a workspace, excluding
// anything already merged (and optionally one item id — used when the vector
// belongs to an existing item). The vector is passed as a planning constant so
// Postgres uses the HNSW index. This is the shared core: `findDuplicateCandidates`
// fetches a stored item vector then calls here; the Autopilot gate embeds an
// inbound capture's text and calls here BEFORE any item exists, to answer
// "is this new?". `vec` is a raw embedding (number[]); we serialise it to
// pgvector's "[a,b,c]" text form (same shape as the customType driver).
export async function findDuplicatesForVector(opts: {
  workspaceId: string;
  vec: number[];
  excludeItemId?: string | null;
  limit?: number;
  threshold?: number;
}): Promise<DuplicateCandidate[]> {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const threshold = opts.threshold ?? defaultThreshold();
  if (!opts.vec.length) return [];
  const vec = `[${opts.vec.join(",")}]`;
  const exclude = opts.excludeItemId ?? "00000000-0000-0000-0000-000000000000";

  const rows = (await db.execute(sql`
    SELECT i.id AS id, i.short_id AS short_id, i.title AS title, i.status AS status,
           1 - (e.embedding <=> ${vec}::vector) AS similarity
    FROM item_embeddings e
    JOIN items i ON i.id = e.item_id
    WHERE e.workspace_id = ${opts.workspaceId}
      AND e.item_id <> ${exclude}
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

// Nearest neighbours to `itemId`'s stored embedding. Two-step (fetch target
// vector, then ANN) so Postgres treats the vector as a planning constant — a
// self-join wouldn't.
export async function findDuplicateCandidates(opts: {
  workspaceId: string;
  itemId: string;
  limit?: number;
  threshold?: number;
}): Promise<DuplicateCandidate[]> {
  const target = (await db.execute(sql`
    SELECT embedding::text AS embedding
    FROM item_embeddings
    WHERE item_id = ${opts.itemId} AND workspace_id = ${opts.workspaceId}
    LIMIT 1
  `)) as unknown as Array<{ embedding: string }>;
  if (!target.length) return [];
  // pgvector text form "[a,b,c]" → number[] for the shared core.
  const vec = JSON.parse(target[0].embedding) as number[];

  return findDuplicatesForVector({
    workspaceId: opts.workspaceId,
    vec,
    excludeItemId: opts.itemId,
    limit: opts.limit,
    threshold: opts.threshold,
  });
}
