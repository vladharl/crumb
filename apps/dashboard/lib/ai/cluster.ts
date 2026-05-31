import "server-only";
import { isCloud } from "@/lib/tier";
import { log } from "@/lib/log";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";

export function clusterConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const CLUSTER_MODEL = AISTACK_MODEL;

type InitiativeBrief = {
  id: string;
  name: string;
  description: string | null;
};

type ItemBrief = {
  title: string;
  body: string;
  type: string;
};

export type ClusterSuggestion = {
  initiativeId: string;
  confidence: number;
  reason: string;
};

// Returns a single best-match suggestion, or null when:
// - not configured (self-host, missing key)
// - no initiatives to pick from
// - model declined to pick (low confidence across the board)
// - API call threw — we swallow because clustering is fire-and-forget
export async function suggestInitiative(
  item: ItemBrief,
  initiatives: InitiativeBrief[],
): Promise<ClusterSuggestion | null> {
  if (!aistackConfigured()) return null;
  if (initiatives.length === 0) return null;

  // Prompt: short, structured. We tell the model to either pick one or
  // return null with a reason. Cap initiative descriptions to keep prompts
  // small; vendors writing essays for their initiative description don't
  // need to pay for it on every cluster call.
  const briefs = initiatives.map((i, idx) => {
    const d = (i.description ?? "").slice(0, 240);
    return `${idx + 1}. id=${i.id} | name="${i.name}"${d ? ` | description="${d}"` : ""}`;
  }).join("\n");

  const body = (item.body ?? "").slice(0, 1200);
  const prompt = `You are classifying a piece of inbound customer feedback into one of the vendor's existing "Initiatives" — manual themed buckets the vendor uses to group related requests.

Initiatives (pick one by id, or return null if none clearly fits):
${briefs}

Feedback to classify:
- type: ${item.type}
- title: ${item.title}
- body: ${body}

Respond with a single line of JSON only — no prose, no code fences. Schema:
{"initiative_id": "<uuid or null>", "confidence": <0..1>, "reason": "<one short sentence>"}

Rules:
- Pick the single best fit. If two are close, pick the more specific one.
- If nothing fits with confidence > 0.55, return null for initiative_id.
- Reason must be ≤ 120 characters and reference the feedback's substance.`;

  // max_tokens 1024 (not the old 200): qwen is a reasoning model, so a tight
  // budget can be spent thinking before the JSON answer is emitted.
  const text = await aistackChat(prompt, { maxTokens: 1024, temperature: 0.1, scope: "crumb/ai" });
  if (!text) return null;

  try {
    // Tolerate any preamble/reasoning leakage or code fences: grab the first
    // {...} object, then strip stray fences.
    const m = text.match(/\{[\s\S]*\}/);
    const cleaned = (m ? m[0] : text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      initiative_id: string | null;
      confidence: number;
      reason: string;
    };

    if (!parsed.initiative_id) return null;
    if (typeof parsed.confidence !== "number") return null;
    if (parsed.confidence < 0.55) return null;
    if (!initiatives.some(i => i.id === parsed.initiative_id)) return null;

    return {
      initiativeId: parsed.initiative_id,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reason: (parsed.reason ?? "").slice(0, 240),
    };
  } catch (err) {
    log.error("cluster parse failed", { scope: "crumb/ai", err });
    return null;
  }
}
