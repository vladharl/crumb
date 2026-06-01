import "server-only";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// AI session-replay summaries (feature 8). Turns the compact action trace from
// lib/replay/summarize.ts into a short narrative + highlight beats. Cloud-only;
// swapped for replay-summary.community.ts on self-host.

export function replaySummaryConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const REPLAY_SUMMARY_MODEL = AISTACK_MODEL;

export type ReplaySummaryResult = { summary: string; highlights: string[] };

export async function summarizeSession(
  trace: string,
  ctx?: { pageUrl?: string | null; durationMs?: number },
): Promise<ReplaySummaryResult | null> {
  if (!aistackConfigured()) return null;
  if (!trace.trim()) return null;

  const dur = ctx?.durationMs ? `${Math.round(ctx.durationMs / 1000)}s` : "unknown";
  const prompt = `You are summarizing a customer's screen session (from a click/navigation trace) so a product manager grasps what happened in seconds. Be concrete and behavioral: what the user was trying to do, where they hesitated or clicked repeatedly, and where they went idle. Don't restate every line.

Session duration: ${dur}${ctx?.pageUrl ? `\nStart page: ${ctx.pageUrl}` : ""}

Trace (timestamps mm:ss):
${trace.slice(0, 4000)}

Respond with a single line of JSON only — no prose, no code fences:
{"summary":"<2-3 sentence narrative>","highlights":["<short beat, e.g. 'hunted for Export for 40s'>"]}`;

  const text = await aistackChat(prompt, { maxTokens: 800, temperature: 0.3, scope: "crumb/ai" });
  const parsed = parseJsonLine<{ summary?: string; highlights?: unknown }>(text);
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) return null;

  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.filter((h): h is string => typeof h === "string" && h.trim().length > 0).slice(0, 6)
    : [];
  return { summary: parsed.summary.trim(), highlights };
}
