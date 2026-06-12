import "server-only";

// Community-edition stub for lib/ai/triage.ts — aliased in when CRUMB_EDITION
// != cloud. triageConfigured() === false and suggestTriage() === null, so the
// capture route never runs triage on self-host (and the aistack client stays
// out of the bundle).

export const TRIAGE_MODEL = "qwen-35b-8bit";

export type TriageMember = { id: string; name: string; role: string };
export type ItemBrief = { title: string; body: string; type: string };
export type TriageResult = {
  type: string | null;
  severity: string | null;
  sentiment: number | null;
  urgency: number | null;
  suggestedAssigneeId: string | null;
  isDuplicateLikely: boolean;
  lang: string | null;
  summary: string | null;
  reason: string;
  confidence: number;
};

export function triageConfigured(): boolean {
  return false;
}

export async function suggestTriage(
  _item: ItemBrief,
  _members: TriageMember[],
): Promise<TriageResult | null> {
  return null;
}
