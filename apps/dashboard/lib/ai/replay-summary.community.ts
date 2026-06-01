import "server-only";

// Community-edition stub for lib/ai/replay-summary.ts — replay summaries are
// Cloud-only (they also need session record). The EE route that calls this is
// stripped from the self-host build.

export const REPLAY_SUMMARY_MODEL = "qwen-35b-8bit";

export type ReplaySummaryResult = { summary: string; highlights: string[] };

export function replaySummaryConfigured(): boolean {
  return false;
}

export async function summarizeSession(
  _trace: string,
  _ctx?: { pageUrl?: string | null; durationMs?: number },
): Promise<ReplaySummaryResult | null> {
  return null;
}
