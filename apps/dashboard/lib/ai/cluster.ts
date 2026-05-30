import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { isCloud } from "@/lib/tier";
import { log } from "@/lib/log";

// Pinned model — Haiku is plenty for classification and ~10x cheaper than
// Sonnet. Bump deliberately after testing.
const MODEL = "claude-haiku-4-5-20251001";

// Lazy client — never throw on import. Self-host stays clean; Cloud
// without a key surfaces a "configure ANTHROPIC_API_KEY" warning in the UI.
let cached: Anthropic | null | undefined;

function clientOrNull(): Anthropic | null {
  if (cached !== undefined) return cached;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) { cached = null; return null; }
  cached = new Anthropic({ apiKey: key });
  return cached;
}

export function clusterConfigured(): boolean {
  return isCloud() && clientOrNull() !== null;
}

export const CLUSTER_MODEL = MODEL;

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
  const client = clientOrNull();
  if (!client) return null;
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

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter(b => b.type === "text")
      .map(b => (b as { text: string }).text)
      .join("")
      .trim();
    if (!text) return null;

    // Some models still wrap JSON in code fences despite instructions; strip.
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
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
    log.error("cluster call failed", { scope: "crumb/ai", err });
    return null;
  }
}
