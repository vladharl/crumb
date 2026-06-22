import "server-only";

// Community-edition stub for lib/ai/extract-feedback.ts — aliased in when
// CRUMB_EDITION != cloud. extractConfigured() === false, so the feedback sync
// never runs the extraction gate on self-host: every pulled record lands as a
// raw PENDING capture for manual review, and the aistack client stays out of
// the bundle.

export type ExtractMode = "ticket" | "chat" | "call";
export type ExtractedUnit = {
  title: string;
  body: string;
  type: string;
  severity: string | null;
  tags: string[];
  relevance: number;
  confidence: number;
};

export const EXTRACT_MODEL = "qwen-35b-8bit";

export function extractConfigured(): boolean {
  return false;
}

export async function extractFeedback(_input: {
  mode: ExtractMode;
  subject: string | null;
  text: string;
}): Promise<ExtractedUnit[] | null> {
  return null;
}
