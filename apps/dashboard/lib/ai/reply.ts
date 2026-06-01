import "server-only";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// Customer-facing reply drafting + translation (feature 7). Cloud-only; swapped
// for reply.community.ts on self-host. Language DETECTION happens in triage (#3)
// — this module handles drafting the close-the-loop reply in the vendor's voice
// and translating text on demand.

export function replyConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const REPLY_MODEL = AISTACK_MODEL;

export type DraftReplyInput = {
  item: { title: string; body: string; type: string; status: string };
  recentVendorReplies: string[];
};
export type DraftReplyResult = { draft: string; reason: string; confidence: number };

export async function draftReply(input: DraftReplyInput): Promise<DraftReplyResult | null> {
  if (!aistackConfigured()) return null;

  const voice =
    input.recentVendorReplies.slice(0, 5).map((r, i) => `${i + 1}. ${r.slice(0, 300)}`).join("\n") ||
    "(no prior replies — use a warm, concise, professional tone)";

  const prompt = `You are drafting a customer-facing reply that closes the loop on a piece of product feedback, written in the vendor's voice.

The vendor's recent replies (match this tone — concise, human, no corporate filler):
${voice}

Feedback:
- type: ${input.item.type}
- current status: ${input.item.status}
- title: ${input.item.title}
- body: ${(input.item.body ?? "").slice(0, 1000)}

Write a reply (2–5 sentences) appropriate to the current status — acknowledge + give a next step if it's planned/in progress; thank + point to the change if shipped; empathize + give the honest rationale if declined. Address the customer directly; do NOT include a "Hi <name>" placeholder or a signature.

Respond with a single line of JSON only — no prose, no code fences:
{"draft":"<the reply text>","reason":"<≤100 char why>","confidence":<number 0..1>}`;

  const text = await aistackChat(prompt, { maxTokens: 1024, temperature: 0.5, scope: "crumb/ai" });
  const parsed = parseJsonLine<{ draft?: string; reason?: string; confidence?: number }>(text);
  if (!parsed || typeof parsed.draft !== "string" || !parsed.draft.trim()) return null;
  return {
    draft: parsed.draft.trim(),
    reason: (parsed.reason ?? "").slice(0, 200),
    confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.7,
  };
}

const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  it: "Italian", ja: "Japanese", zh: "Chinese", ko: "Korean", ru: "Russian",
  nl: "Dutch", pl: "Polish", tr: "Turkish", ar: "Arabic", hi: "Hindi",
};

// Translate text into `targetLang` (ISO 639-1). Returns null on failure.
export async function translate(text: string, targetLang: string): Promise<string | null> {
  if (!aistackConfigured()) return null;
  const t = text.trim();
  if (!t) return null;
  const langName = LANG_NAMES[targetLang.toLowerCase()] ?? targetLang;
  const prompt = `Translate the following text into ${langName}. Output ONLY the translation — no quotes, no notes, no original text.\n\n${t.slice(0, 3000)}`;
  const out = await aistackChat(prompt, { maxTokens: 1500, temperature: 0.2, scope: "crumb/ai" });
  return out?.trim() || null;
}
