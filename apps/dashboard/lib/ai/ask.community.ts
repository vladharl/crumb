import "server-only";
import type { Workspace } from "@crumb/db";

// Community-edition stub for lib/ai/ask.ts — "Ask your feedback" is Cloud-only.
// The EE route that calls this is also stripped from the self-host build, so
// this stub mostly exists to keep the bundle free of the aistack/embeddings
// clients if anything references the module.

export const ASK_MODEL = "qwen-35b-8bit";

export type AskCitation = { shortId: string; title: string };
export type AskError = "not_entitled" | "ai_cap_reached" | "embed_failed" | "no_data" | "answer_failed";
export type AskResult =
  | { ok: true; answer: string; citations: AskCitation[] }
  | { ok: false; error: AskError };

export function askConfigured(): boolean {
  return false;
}

export async function askFeedback(
  _workspace: Workspace,
  _question: string,
  _askedByWorkspaceUserId: string | null,
): Promise<AskResult> {
  return { ok: false, error: "not_entitled" };
}
