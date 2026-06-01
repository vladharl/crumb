import "server-only";

// Community-edition stub for lib/ai/embeddings.ts — aliased in when
// CRUMB_EDITION != cloud so the aistack client never enters the self-host
// bundle. Mirrors the disabled runtime: embeddingsConfigured() === false and
// every embed call returns null, so semantic dedup / search degrade to "off".

export const EMBEDDINGS_DIM = 1024;
export const EMBEDDINGS_MODEL = "qwen-embedding";

export function embeddingsConfigured(): boolean {
  return false;
}

export async function embedText(_text: string): Promise<number[] | null> {
  return null;
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  return texts.map(() => null);
}
