import "server-only";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// The "relevant?" half of the Autopilot gate (the "new?" half is pgvector dedup
// in lib/ai/dedup.ts). A pulled record — a support ticket, a chat thread, a Gong
// call transcript — is mostly NOT product feedback. This turns one raw record
// into 0..N normalized feedback units, dropping the noise. A ticket/chat yields
// 0 or 1 unit; a call can yield several. Cloud-only; the community edition swaps
// this for extract-feedback.community.ts so the aistack client stays out of the
// self-host bundle (self-host lands every record raw for manual review instead).

export type ExtractMode = "ticket" | "chat" | "call";

export type ExtractedUnit = {
  title: string;
  body: string;
  type: string; // bug | idea | question | integration
  severity: string | null; // low | medium | high | critical
  tags: string[]; // 0..3 short theme labels for auto-categorize
  relevance: number; // 0..1 — confidence this is real product feedback
  confidence: number; // 0..1 — confidence in this extraction
};

export const EXTRACT_MODEL = AISTACK_MODEL;

export function extractConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

const TYPES = new Set(["bug", "idea", "question", "integration"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

function clamp01(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

type RawUnit = {
  title?: string;
  body?: string;
  type?: string;
  severity?: string | null;
  tags?: unknown;
  relevance?: number;
  confidence?: number;
};

const MODE_NOUN: Record<ExtractMode, string> = {
  ticket: "a customer support ticket",
  chat: "a customer support chat conversation",
  call: "a sales/customer call transcript",
};

// Hard cap on input length so a long transcript can't blow the token budget.
const MAX_INPUT_CHARS = 8000;

export async function extractFeedback(input: {
  mode: ExtractMode;
  subject: string | null;
  text: string;
}): Promise<ExtractedUnit[] | null> {
  if (!aistackConfigured()) return null;

  const text = (input.text ?? "").slice(0, MAX_INPUT_CHARS);
  if (!text.trim()) return [];
  const subjectLine = input.subject ? `Subject: ${input.subject}\n` : "";

  const prompt = `You extract PRODUCT FEEDBACK from ${MODE_NOUN[input.mode]} for a product team.

Pull out distinct pieces of product feedback: feature requests, bug reports, usability complaints, integration asks, and specific praise about the product. Each distinct request/issue is its own unit.

IGNORE everything that is not product feedback: scheduling/logistics, pricing or contract negotiation, account/billing/password/login-reset issues, generic how-to questions answered by docs, pleasantries, and internal sales chatter. A ${input.mode === "call" ? "call may contain several distinct items, or none" : "ticket/chat usually contains zero or one item"}.

${subjectLine}Content:
${text}

Respond with a single line of JSON only — no prose, no code fences. A JSON array (possibly empty). Each element:
{"title":"<short imperative summary>","body":"<1-3 sentence paraphrase in English>","type":"bug|idea|question|integration","severity":"low|medium|high|critical","tags":["<theme>", ...],"relevance":<0..1>,"confidence":<0..1>}

Rules:
- Return [] if there is no genuine product feedback.
- title: concise, what the customer wants or reports. body: faithful paraphrase, no "the customer..." preamble.
- type: bug (broken), idea (new/changed capability), integration (wants to connect another tool), question (genuine product question worth tracking).
- severity: how blocking for the customer.
- tags: 0-3 short lowercase theme labels (e.g. "exports", "mobile", "sso"). Reuse obvious shared themes.
- relevance: how confidently this is real, actionable product feedback (low for vague grumbles).
- confidence: how confident you are this extraction is accurate.`;

  const raw = await aistackChat(prompt, { maxTokens: 2048, temperature: 0.1, scope: "crumb/ai" });
  return parseExtraction(raw);
}

// Parse + normalize the model's JSON-array response into validated units. Pure
// (no I/O) so it's unit-testable. Returns null on unparseable output, [] when the
// model correctly reports no feedback.
export function parseExtraction(text: string | null | undefined): ExtractedUnit[] | null {
  const parsed = parseJsonArray<RawUnit>(text);
  if (!parsed) return null;

  const out: ExtractedUnit[] = [];
  for (const u of parsed) {
    const title = typeof u.title === "string" ? u.title.trim().slice(0, 200) : "";
    if (!title) continue;
    out.push({
      title,
      body: typeof u.body === "string" ? u.body.trim().slice(0, 4000) : "",
      type: typeof u.type === "string" && TYPES.has(u.type) ? u.type : "idea",
      severity: typeof u.severity === "string" && SEVERITIES.has(u.severity) ? u.severity : null,
      tags: Array.isArray(u.tags)
        ? u.tags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().toLowerCase().slice(0, 64))
            .filter(Boolean)
            .slice(0, 3)
        : [],
      relevance: clamp01(u.relevance),
      confidence: clamp01(u.confidence),
    });
  }
  return out;
}

// Like parseJsonLine but for a top-level array. Tolerates reasoning preamble and
// ```json fences (qwen leaks both).
function parseJsonArray<T>(text: string | null | undefined): T[] | null {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  const cleaned = (m ? m[0] : text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const v = JSON.parse(cleaned);
    return Array.isArray(v) ? (v as T[]) : null;
  } catch {
    return null;
  }
}
