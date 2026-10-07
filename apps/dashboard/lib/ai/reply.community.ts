import "server-only";

// Community-edition stub for lib/ai/reply.ts — reply drafting + translation are
// Cloud-only. replyConfigured() === false; the draft/translate calls return
// null, so the thread UI hides the AI controls on self-host.

export const REPLY_MODEL = "qwen-35b-8bit";

export type DraftReplyInput = {
  item: { title: string; body: string; type: string; status: string };
  lang: string | null;
  thread: Array<{ fromVendor: boolean; body: string }>;
  styleExamples: Array<{ body: string; names: string[] }>;
};
export type DraftReplyResult = { draft: string; reason: string; confidence: number };

export function replyConfigured(): boolean {
  return false;
}

export async function draftReply(_input: DraftReplyInput): Promise<DraftReplyResult | null> {
  return null;
}

export async function translate(_text: string, _targetLang: string): Promise<string | null> {
  return null;
}
