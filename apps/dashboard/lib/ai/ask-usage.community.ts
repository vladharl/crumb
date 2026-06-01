import "server-only";
import type { Workspace } from "@crumb/db";

// Community-edition stub for lib/ai/ask-usage.ts — AI usage queries are
// Cloud-only. The EE route that calls this is stripped from the self-host
// build; this stub keeps the bundle free of the aistack client.

export const ASK_USAGE_MODEL = "qwen-35b-8bit";

export type AskUsageError = "not_entitled" | "ai_cap_reached" | "no_data" | "answer_failed" | "unclear";
export type AskUsageResult =
  | { ok: true; answer: string; metric: string; windowDays: number }
  | { ok: false; error: AskUsageError };

export function askUsageConfigured(): boolean {
  return false;
}

export async function askUsage(_workspace: Workspace, _question: string): Promise<AskUsageResult> {
  return { ok: false, error: "not_entitled" };
}
