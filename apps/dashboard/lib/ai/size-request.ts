import "server-only";
import { isCloud } from "@/lib/tier";
import { log } from "@/lib/log";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// Slack Phase-0 request sizing. One model call: restate the request, T-shirt
// size it (S/M/L/XL) against the connected repo's shape, and rate confidence.
// Same model + gating pattern as lib/ai/ticket.ts. Revenue is computed
// deterministically by the caller and never passed in — the model can't
// hallucinate dollars.
export function sizeRequestConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const SIZE_REQUEST_MODEL = AISTACK_MODEL;

export type SizeRequestInput = {
  requestText: string;
  // GitHub-only repo context (README + top-level tree), when connected. Lets
  // the model ground scope in what the product actually is. Absent → sizes from
  // the request text alone and confidence is forced low.
  repoContext?: {
    repo: string;
    readme: string | null;
    topLevelTree: string | null;
  };
  // Titles of similar existing requests — helps the model see whether this is a
  // small extension of a known area or net-new.
  similar: Array<{ title: string; status: string }>;
};

export type Size = "S" | "M" | "L" | "XL";
export type Confidence = "low" | "medium" | "high";
export type SizeRequestResult = {
  restatement: string;
  size: Size;
  rationale: string;
  confidence: Confidence;
};

const REQUEST_MAX = 1500;
const README_MAX = 4000;
const TREE_MAX = 400;
const SIMILAR_MAX = 5;

const SIZES = new Set<Size>(["S", "M", "L", "XL"]);
const CONFIDENCES = new Set<Confidence>(["low", "medium", "high"]);

export async function sizeRequest(input: SizeRequestInput): Promise<SizeRequestResult | null> {
  if (!aistackConfigured()) return null;

  const request = (input.requestText ?? "").slice(0, REQUEST_MAX);
  if (!request.trim()) return null;
  const readme = input.repoContext?.readme ? input.repoContext.readme.slice(0, README_MAX) : null;
  const tree = input.repoContext?.topLevelTree ? input.repoContext.topLevelTree.slice(0, TREE_MAX) : null;
  const hasRepo = !!(readme || tree);

  const repoBlock = hasRepo
    ? [
        `Connected repository: ${input.repoContext?.repo ?? "unknown"}`,
        readme ? `Project README (truncated):\n"""\n${readme}\n"""` : "",
        tree ? `Repo top-level paths: ${tree}` : "",
      ].filter(Boolean).join("\n")
    : "(no repository connected — size from the request description alone)";

  const similarBlock = input.similar.length
    ? input.similar.slice(0, SIMILAR_MAX).map(s => `- [${s.status}] ${s.title}`).join("\n")
    : "(no similar existing requests found)";

  const prompt = `You size incoming product requests for the engineering team that owns the product below. Estimate the engineering effort as a T-shirt size, grounded in what the repository implies the product is.

${repoBlock}

Similar existing requests (for whether this is an extension of a known area or net-new):
${similarBlock}

Request to size:
"""
${request}
"""

Respond with a single line of JSON only — no prose, no code fences. Schema:
{"restatement":"<neutral one-line restatement of the request, ≤120 chars>","size":"S"|"M"|"L"|"XL","rationale":"<1-2 sentences on why this size>","confidence":"low"|"medium"|"high"}

Rules:
- Sizes: S = hours to a day; M = a few days; L = one to two weeks; XL = multi-week or architectural.
- The rationale MUST describe scope in PRODUCT terms only. Do NOT name any file, directory, module, class, function, or internal component from the repository (say "touches the notification flow", never a path or symbol).
- If no repository is connected, size from the request text alone and set confidence to "low".`;

  const text = await aistackChat(prompt, { maxTokens: 700, temperature: 0.2, scope: "crumb/ai/size" });
  if (!text) return null;

  const parsed = parseJsonLine<{
    restatement?: string;
    size?: string;
    rationale?: string;
    confidence?: string;
  }>(text);
  if (!parsed) {
    log.error("sizeRequest parse failed", { scope: "crumb/ai/size" });
    return null;
  }

  const restatement = (parsed.restatement ?? "").trim().slice(0, 120);
  const rationale = (parsed.rationale ?? "").trim().slice(0, 400);
  if (!restatement || !rationale) return null;
  const size = SIZES.has(parsed.size as Size) ? (parsed.size as Size) : null;
  if (!size) return null;
  // No repo context → the model can't honestly claim high/medium confidence.
  const rawConf = CONFIDENCES.has(parsed.confidence as Confidence) ? (parsed.confidence as Confidence) : "low";
  const confidence = hasRepo ? rawConf : "low";

  return { restatement, size, rationale, confidence };
}
