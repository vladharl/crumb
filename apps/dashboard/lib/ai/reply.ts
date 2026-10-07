import "server-only";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL, NO_EM_DASH_RULE } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// Customer-facing reply drafting + translation (feature 7). Cloud-only; swapped
// for reply.community.ts on self-host. Language DETECTION happens in triage (#3);
// this module drafts the close-the-loop reply in the vendor's voice, in the
// customer's language, and translates text on demand.

export function replyConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const REPLY_MODEL = AISTACK_MODEL;

export type DraftReplyInput = {
  item: { title: string; body: string; type: string; status: string };
  // ISO 639-1 code of the language the customer wrote in (triage's guess).
  lang: string | null;
  // This thread's customer-visible messages, oldest first.
  thread: Array<{ fromVendor: boolean; body: string }>;
  // The vendor's replies on other threads, for tone only. `names` are that
  // thread's account and customer; scrubStyleExample takes them out.
  styleExamples: Array<{ body: string; names: string[] }>;
};
export type DraftReplyResult = { draft: string; reason: string; confidence: number };

// Function words that open company names ("The Data Company"); never scrubbed,
// or every sentence-initial "The" in an example would go.
const NOT_NAMES = new Set(["The", "And", "For"]);

// Takes out of a style example whatever could carry another customer's details
// into this reply: links, emails, numbers, whoever a greeting addresses, and
// the given names (each word of 3+ letters, matched case-sensitively since
// names are capitalized). Only the tone should carry over.
export function scrubStyleExample(text: string, names: string[]): string {
  let s = text
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\d+([.,:/-]\d+)*/g, "[number]")
    .replace(/\b(hi|hey|hello|dear)\s+[^\s,!.:;]+/gi, "$1 [name]");
  for (const word of new Set(names.flatMap((n) => n.split(/[^\p{L}\p{N}]+/u)))) {
    if (word.length < 3 || NOT_NAMES.has(word)) continue;
    s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "gu"), "[name]");
  }
  return s;
}

export async function draftReply(input: DraftReplyInput): Promise<DraftReplyResult | null> {
  if (!aistackConfigured()) return null;

  const voice =
    input.styleExamples.slice(0, 5).map((e, i) => `${i + 1}. ${scrubStyleExample(e.body, e.names).slice(0, 300)}`).join("\n") ||
    "(no prior replies: use a warm, concise, professional tone)";
  const history =
    input.thread.slice(-10).map((m) => `${m.fromVendor ? "Vendor" : "Customer"}: ${m.body.slice(0, 600)}`).join("\n\n") ||
    "(no replies yet)";
  const language = input.lang ? (LANG_NAMES[input.lang.toLowerCase()] ?? input.lang) : null;

  const prompt = `You are drafting a customer-facing reply that closes the loop on a piece of product feedback, written in the vendor's voice.

The vendor's replies on other threads, for tone only (concise, human, no corporate filler). Never reuse their names, numbers, links or details:
${voice}

Feedback:
- type: ${input.item.type}
- current status: ${input.item.status}
- title: ${input.item.title}
- body: ${(input.item.body ?? "").slice(0, 1000)}

This thread so far, oldest first:
${history}

Write a reply (2 to 5 sentences) that answers the customer's latest message and fits the current status: acknowledge it and give a next step if it's planned or in progress; thank them and point to the change if it shipped; empathize and give the honest rationale if it was declined. Stay consistent with what the vendor already said in this thread, and don't repeat it. Write the reply in ${language ?? "the language the customer wrote in"}. Address the customer directly; do NOT include a "Hi <name>" placeholder or a signature. ${NO_EM_DASH_RULE}

Respond with a single line of JSON only, no prose and no code fences:
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
  const prompt = `Translate the following text into ${langName}. Output ONLY the translation: no quotes, no notes, no original text. ${NO_EM_DASH_RULE}\n\n${t.slice(0, 3000)}`;
  const out = await aistackChat(prompt, { maxTokens: 1500, temperature: 0.2, scope: "crumb/ai" });
  return out?.trim() || null;
}
