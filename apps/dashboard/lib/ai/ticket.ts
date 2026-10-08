import "server-only";
import { isCloud } from "@/lib/tier";
import { log } from "@/lib/log";
import { formatArr } from "@/lib/priority";
import { aistackChat, aistackConfigured, AISTACK_MODEL, NO_EM_DASH_RULE } from "@/lib/ai/aistack";

// AI ticket drafting. Same model + gating pattern as lib/ai/cluster.ts.
export function ticketSuggestionConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const TICKET_MODEL = AISTACK_MODEL;

// Who is asking and what they're worth, plus the way back to the thread.
// Counted by the caller over the item's merge group; never shown to the model,
// so no figure in the ticket can be made up.
export type TicketImpact = {
  accountName: string;
  arrCents: number;
  accounts: number;          // distinct accounts asking
  combinedArrCents: number;  // their summed ARR
  requesters: number;        // distinct people asking
  threadUrl: string | null;
};

export type SuggestTicketInput = {
  provider: "linear" | "jira" | "github";
  item: { title: string; body: string; type: string };
  // Up to 10 recent ticket titles from the target — gives the model the
  // team's voice without paying for full bodies.
  recentTickets: Array<{ identifier: string; title: string; stateName: string }>;
  // GitHub-only repo context. Always fetched from the workspace's
  // connected GitHub repo when present — feeds drafts targeting *any*
  // provider, because teams often use GitHub for code + Linear/Jira
  // for tickets.
  repoContext?: {
    repo: string;            // "owner/name"
    readme: string | null;   // capped to 4000 chars upstream
    topLevelTree: string | null; // comma-joined paths, capped 400 chars upstream
  };
  // Appended to the drafted body as a footer (ticketImpactFooter).
  impact?: TicketImpact;
};

export type SuggestTicketResult = {
  title: string;
  body: string;
  labels: string[] | null;
  reason: string;
  confidence: number;
};

// "Customer impact: Acme Co, $250k ARR. 4 requesters across 3 accounts, $410k
// ARR at stake." then a link to the thread. A GitHub repo can be public, so a
// GitHub ticket never names the customer or what they pay: "Customer impact:
// 4 requesters across 3 accounts." and the link.
export function ticketImpactFooter(t: TicketImpact, provider?: SuggestTicketInput["provider"]): string {
  const publicRepo = provider === "github";
  const arr = formatArr(t.arrCents, " ARR");
  const people = `${t.requesters} ${t.requesters === 1 ? "requester" : "requesters"}`;
  const reach = t.accounts > 1
    ? `${people} across ${t.accounts} accounts${!publicRepo && t.combinedArrCents > 0 ? `, ${formatArr(t.combinedArrCents, " ARR at stake")}` : ""}`
    : people;
  const lines = [publicRepo ? `Customer impact: ${reach}.` : `Customer impact: ${t.accountName}, ${arr}. ${reach}.`];
  if (t.threadUrl) lines.push(`Thread in Crumb: ${t.threadUrl}`);
  return lines.join("\n\n");
}

// Caps mirror lib/ai/cluster.ts. Total prompt stays under ~8K input tokens.
const ITEM_BODY_MAX = 1200;
const README_MAX = 4000;
const TREE_MAX = 400;
const RECENT_MAX = 10;

export async function suggestTicket(input: SuggestTicketInput): Promise<SuggestTicketResult | null> {
  if (!aistackConfigured()) return null;

  const itemBody = (input.item.body ?? "").slice(0, ITEM_BODY_MAX);
  const tickets = input.recentTickets.slice(0, RECENT_MAX);
  const readme = input.repoContext?.readme ? input.repoContext.readme.slice(0, README_MAX) : null;
  const tree = input.repoContext?.topLevelTree ? input.repoContext.topLevelTree.slice(0, TREE_MAX) : null;

  const recentBlock = tickets.length
    ? tickets.map(t => `- [${t.stateName}] ${t.identifier}: ${t.title}`).join("\n")
    : "(no recent tickets to learn voice from)";

  const repoBlock = (readme || tree)
    ? [
        readme ? `\nProject README (truncated):\n"""\n${readme}\n"""` : "",
        tree ? `\nRepo top-level paths: ${tree}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const providerLabel = input.provider === "linear" ? "Linear" : input.provider === "jira" ? "Jira" : "GitHub";

  const prompt = `You draft engineering tickets for a vendor's ${providerLabel} workspace based on customer feedback received through Crumb.

Recent tickets in the target project (for voice + label style):
${recentBlock}
${repoBlock}

Customer feedback to convert into a ${providerLabel} ticket:
- type: ${input.item.type}
- title: ${input.item.title}
- body: ${itemBody || "(no body)"}

Write a clean engineering ticket. Match the voice of the recent tickets above. If the recent tickets use a labels convention, suggest 1-3 labels in that style (lowercase kebab-case unless the existing labels suggest otherwise).

Respond with a single line of JSON only, no prose and no code fences. Schema:
{"title": "<short imperative title>", "body": "<markdown body, 2-5 paragraphs>", "labels": ["..."] | null, "reason": "<one short sentence on why this framing>", "confidence": <0..1>}

Rules:
- Title is imperative, ≤80 chars, no trailing punctuation.
- Body is markdown. Start with a one-sentence summary. Don't quote the entire raw feedback; paraphrase and reference it.
- Don't add an attribution line, links, customer names or revenue figures. Crumb appends who is asking, their ARR and a link to the thread.
- Labels can be null if recent tickets show no clear convention.
- Reason ≤ 120 characters.
- Confidence ≥ 0.6 means "I'm confident this matches the team's style"; below 0.6 means "best effort, vendor should review".
- ${NO_EM_DASH_RULE}`;

  // max_tokens 2048 (not the old 800): qwen is a reasoning model and ticket
  // bodies run longer, so leave room for thinking + a multi-paragraph draft.
  const text = await aistackChat(prompt, { maxTokens: 2048, temperature: 0.4, scope: "crumb/ai/ticket" });
  if (!text) return null;

  try {
    // Tolerate any preamble/reasoning leakage or code fences: grab the first
    // {...} object, then strip stray fences.
    const m = text.match(/\{[\s\S]*\}/);
    const cleaned = (m ? m[0] : text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      title?: string;
      body?: string;
      labels?: string[] | null;
      reason?: string;
      confidence?: number;
    };

    const title = (parsed.title ?? "").trim();
    if (!title) return null;
    const drafted = (parsed.body ?? "").trim();
    const body = input.impact ? [drafted, ticketImpactFooter(input.impact, input.provider)].filter(Boolean).join("\n\n") : drafted;
    // Commas separate labels in the ticket modal, so none inside one.
    const labels = Array.isArray(parsed.labels)
      ? Array.from(new Set(parsed.labels
          .filter((l): l is string => typeof l === "string")
          .map(l => l.replace(/\s*,\s*/g, " ").trim().slice(0, 50))
          .filter(Boolean))).slice(0, 5)
      : null;
    const reason = (parsed.reason ?? "").slice(0, 240);
    const confidence = typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.6;

    return { title, body, labels: labels && labels.length ? labels : null, reason, confidence };
  } catch (err) {
    log.error("suggestTicket failed", { scope: "crumb/ai/ticket", err });
    return null;
  }
}
