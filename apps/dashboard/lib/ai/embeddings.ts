import "server-only";
import { log } from "@/lib/log";
import { isCloud } from "@/lib/tier";

// Cloud-only embeddings client for the aistack (OpenAI-compatible) /embeddings
// endpoint. Mirrors lib/ai/aistack.ts's fetch/auth/timeout discipline but for
// vectors instead of chat. The community edition swaps this for embeddings.
// community.ts at build time (see next.config.mjs), so it never enters the
// self-host bundle. Best-effort: every failure returns null — callers treat a
// null embedding as "skip", never throw.

const DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B";
const DEFAULT_BASE_URL = "https://aistack.eissa.cloud/v1";
// Embeddings are cheap + fast relative to chat; no 36 GB chat model to cold-load,
// so a tighter bound than aistackChat's 120s is fine.
const TIMEOUT_MS = 60_000;

// Pinned to the vector(1024) column in packages/db/src/schema.ts (VECTOR_DIM).
// Qwen3-Embedding-8B is natively 4096-dim, but it's Matryoshka (MRL)-trained:
// the first N dims (re-normalized) are a valid lower-dim embedding. We keep 1024
// because pgvector's HNSW index maxes out at 2000 dims — so we ask the server
// for `dimensions: 1024` AND defensively truncate+renormalize on our side (in
// case the server ignores the param and returns the full 4096). No migration
// needed to change models, as long as we land on a 1024-dim vector.
export const EMBEDDINGS_DIM = 1024;
export const EMBEDDINGS_MODEL = process.env.AISTACK_EMBEDDINGS_MODEL?.trim() || DEFAULT_MODEL;

export function embeddingsConfigured(): boolean {
  return isCloud() && !!process.env.AISTACK_API_KEY?.trim();
}

function baseUrl(): string {
  const raw =
    process.env.EMBEDDINGS_BASE_URL?.trim() ||
    process.env.AISTACK_BASE_URL?.trim() ||
    DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// Raw call. `input` may be a single string or an array (batched). Returns the
// parallel array of vectors, or null on missing key / non-2xx / timeout / error.
async function postEmbeddings(input: string | string[]): Promise<number[][] | null> {
  const key = process.env.AISTACK_API_KEY?.trim();
  if (!key) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl()}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      // `dimensions` asks an MRL-capable server to return EMBEDDINGS_DIM-length
      // vectors directly (OpenAI-compatible). Ignored servers return full length;
      // normalizeToDim() truncates on our side either way.
      body: JSON.stringify({ model: EMBEDDINGS_MODEL, input, dimensions: EMBEDDINGS_DIM }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      log.error("aistack embeddings failed", { scope: "crumb/ai", status: resp.status });
      return null;
    }
    // OpenAI-compatible shape: { data: [{ index, embedding: number[] }, …] }.
    // Sort by index defensively — some servers don't guarantee input order.
    const data = (await resp.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
    };
    const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.map((r) => r.embedding ?? []);
  } catch (err) {
    log.error("aistack embeddings error", { scope: "crumb/ai", err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Coerce a returned vector to exactly EMBEDDINGS_DIM. A longer vector (e.g. the
// native 4096 of Qwen3-Embedding-8B) is MRL-truncated to the first EMBEDDINGS_DIM
// dims and re-normalized to unit length (the correct MRL step + keeps cosine
// well-behaved). A SHORTER vector can't be reconstructed → dropped, never stored
// (a wrong-length vector would corrupt ANN results silently).
function normalizeToDim(v: number[] | undefined): number[] | null {
  if (!v || v.length < EMBEDDINGS_DIM) {
    if (v && v.length) {
      log.error("embedding too short, dropped", {
        scope: "crumb/ai", got: v.length, want: EMBEDDINGS_DIM, model: EMBEDDINGS_MODEL,
      });
    }
    return null;
  }
  const sliced = v.length > EMBEDDINGS_DIM ? v.slice(0, EMBEDDINGS_DIM) : v;
  let norm = 0;
  for (const x of sliced) norm += x * x;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return null;
  return sliced.map((x) => x / norm);
}

export async function embedText(text: string): Promise<number[] | null> {
  const t = text.trim();
  if (!t) return null;
  const out = await postEmbeddings(t);
  if (!out || out.length === 0) return null;
  return normalizeToDim(out[0]);
}

// Batched embedding. Returns one slot per input (null where that slot failed
// or was too short), so callers can zip back to their items by index.
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const out = await postEmbeddings(texts);
  if (!out) return texts.map(() => null);
  return texts.map((_, i) => normalizeToDim(out[i]));
}
