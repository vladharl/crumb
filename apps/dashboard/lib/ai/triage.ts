import "server-only";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL, NO_EM_DASH_RULE } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// AI auto-triage (feature 3). Runs fire-and-forget at capture: classifies the
// item's type/severity/sentiment/urgency, proposes an owner, and flags likely
// duplicates. Writes are ADVISORY (item.ai_* columns) — never the canonical
// type/assignee/status. Cloud-only; the community edition swaps this for
// triage.community.ts so the aistack client stays out of the self-host bundle.
//
// Initiative suggestion is intentionally NOT done here — the existing
// lib/ai/cluster.ts path already owns that (and its own metered unit), with a
// tuned confidence threshold. Keeping the concerns separate avoids two writers
// to initiative_suggestions.

export function triageConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const TRIAGE_MODEL = AISTACK_MODEL;

export type TriageMember = { id: string; name: string; role: string };
export type ItemBrief = { title: string; body: string; type: string };

export type TriageResult = {
  type: string | null; // bug | idea | question | integration
  severity: string | null; // low | medium | high | critical
  sentiment: number | null; // -1..1
  urgency: number | null; // 0..1
  suggestedAssigneeId: string | null;
  isDuplicateLikely: boolean;
  lang: string | null; // ISO 639-1 (e.g. "en", "es") — feeds translation (#7)
  summary: string | null; // one-line inbox preview, vendor-facing
  reason: string;
  confidence: number;
};

const TYPES = new Set(["bug", "idea", "question", "integration"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

function clampOrNull(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

type RawTriage = {
  type?: string;
  severity?: string;
  sentiment?: number;
  urgency?: number;
  suggested_assignee_id?: string | null;
  is_duplicate_likely?: boolean;
  lang?: string;
  summary?: string;
  reason?: string;
  confidence?: number;
};

export async function suggestTriage(
  item: ItemBrief,
  members: TriageMember[],
): Promise<TriageResult | null> {
  if (!aistackConfigured()) return null;

  const memberLines =
    members
      .slice(0, 25)
      .map((m, i) => `${i + 1}. id=${m.id} | name="${m.name}" | role=${m.role}`)
      .join("\n") || "(no team members listed)";
  const body = (item.body ?? "").slice(0, 1500);

  const prompt = `You are triaging a piece of inbound customer feedback for a product team. Classify it and propose routing.

Team members who could own this (pick one id as the suggested owner, or null):
${memberLines}

Feedback:
- declared type: ${item.type}
- title: ${item.title}
- body: ${body}

Respond with a single line of JSON only, no prose and no code fences. Schema:
{"type":"bug|idea|question|integration","severity":"low|medium|high|critical","sentiment":<number -1..1>,"urgency":<number 0..1>,"suggested_assignee_id":"<id from the list, or null>","is_duplicate_likely":<true|false>,"lang":"<ISO 639-1 code, e.g. en/es/fr/de/ja>","summary":"<one line>","reason":"<one short sentence>","confidence":<number 0..1>}

Rules:
- type: correct the declared type only if it's clearly wrong, otherwise echo it.
- severity: how blocking for the customer (a bug stopping their work = high/critical; a minor idea = low).
- sentiment: the customer's tone, -1 (angry/frustrated) … 1 (delighted). urgency: 0 (whenever) … 1 (needs it now).
- suggested_assignee_id MUST be one of the ids listed above, or null. Never invent an id.
- is_duplicate_likely: true if this reads like a frequently-repeated request.
- lang: the ISO 639-1 language code the feedback is written in.
- summary: one plain sentence ≤ 140 characters a product team member can scan in an inbox: what the customer wants or reports, concrete, in English, no preamble like "The customer...".
- reason ≤ 120 characters, referencing the feedback's substance.
- ${NO_EM_DASH_RULE}`;

  const text = await aistackChat(prompt, { maxTokens: 1024, temperature: 0.1, scope: "crumb/ai" });
  const parsed = parseJsonLine<RawTriage>(text);
  if (!parsed) return null;

  const suggestedAssigneeId =
    typeof parsed.suggested_assignee_id === "string" &&
    members.some((m) => m.id === parsed.suggested_assignee_id)
      ? parsed.suggested_assignee_id
      : null;

  return {
    type: typeof parsed.type === "string" && TYPES.has(parsed.type) ? parsed.type : null,
    severity:
      typeof parsed.severity === "string" && SEVERITIES.has(parsed.severity) ? parsed.severity : null,
    sentiment: clampOrNull(parsed.sentiment, -1, 1),
    urgency: clampOrNull(parsed.urgency, 0, 1),
    suggestedAssigneeId,
    isDuplicateLikely: parsed.is_duplicate_likely === true,
    lang: typeof parsed.lang === "string" && /^[a-z]{2}$/i.test(parsed.lang) ? parsed.lang.toLowerCase() : null,
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim().replace(/\s+/g, " ").slice(0, 200)
        : null,
    reason: (parsed.reason ?? "").slice(0, 240),
    confidence: clampOrNull(parsed.confidence, 0, 1) ?? 0,
  };
}
