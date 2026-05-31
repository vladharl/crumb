import "server-only";

// Community-edition stub for lib/ai/cluster.ts — aliased in when CRUMB_EDITION
// != cloud so the aistack client never enters the bundle. Mirrors the self-host
// runtime (clusterConfigured() === false; suggestInitiative() === null).

export const CLUSTER_MODEL = "qwen-35b-8bit";

export type ClusterSuggestion = {
  initiativeId: string;
  confidence: number;
  reason: string;
};

export function clusterConfigured(): boolean {
  return false;
}

export async function suggestInitiative(
  _item: { title: string; body: string; type: string },
  _initiatives: Array<{ id: string; name: string; description: string | null }>,
): Promise<ClusterSuggestion | null> {
  return null;
}
