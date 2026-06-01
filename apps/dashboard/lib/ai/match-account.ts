import "server-only";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";
import { parseJsonLine } from "@/lib/ai/run";

// AI account suggester for inbound captures (meet-customers-where-they-are).
// Given an inbound email + the workspace's accounts, propose the best-matching
// account so the vendor can confirm with one click. Cloud-only; swapped for
// match-account.community.ts on self-host (captures land unmapped there).
//
// A deterministic heuristic runs first (exact name mention / email-domain
// match) — it's cheap, explainable, and makes e2e stable; the model is only the
// fallback.

export function matchAccountConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const MATCH_ACCOUNT_MODEL = AISTACK_MODEL;

export type AccountChoice = { id: string; name: string };
export type AccountSuggestion = { accountId: string | null; accountName: string | null; confidence: number };

export async function suggestAccount(
  input: { fromEmail: string | null; fromName: string | null; subject: string | null; body: string },
  accounts: AccountChoice[],
): Promise<AccountSuggestion | null> {
  if (accounts.length === 0) return null;

  // 1) Heuristic: exact account-name mention, or email-domain token match.
  const haystack = `${input.subject ?? ""} ${input.body ?? ""} ${input.fromName ?? ""} ${input.fromEmail ?? ""}`.toLowerCase();
  const domainBase = input.fromEmail?.split("@")[1]?.split(".")[0]?.toLowerCase() ?? "";
  for (const a of accounts) {
    const nameLc = a.name.toLowerCase();
    const tokens = nameLc.split(/[^a-z0-9]+/).filter(Boolean);
    if (nameLc.length >= 3 && haystack.includes(nameLc)) return { accountId: a.id, accountName: a.name, confidence: 0.95 };
    if (domainBase.length >= 3 && tokens.includes(domainBase)) return { accountId: a.id, accountName: a.name, confidence: 0.9 };
  }

  // 2) Model fallback.
  if (!aistackConfigured()) return null;
  const list = accounts.slice(0, 50).map((a, i) => `${i + 1}. id=${a.id} | name="${a.name}"`).join("\n");
  const prompt = `You are matching inbound customer feedback to the right customer account (which customer account does this email belong to?).

Accounts (pick one by id, or null if none clearly fits):
${list}

Email:
- from: ${input.fromName ?? ""} <${input.fromEmail ?? ""}>
- subject: ${input.subject ?? ""}
- body: ${(input.body ?? "").slice(0, 1000)}

Respond with a single line of JSON only — no prose, no code fences:
{"account_id":"<id from the list, or null>","account_name":"<best-guess company name if no id fits, else null>","confidence":<number 0..1>}`;

  const text = await aistackChat(prompt, { maxTokens: 512, temperature: 0.1, scope: "crumb/ai" });
  const parsed = parseJsonLine<{ account_id?: string | null; account_name?: string | null; confidence?: number }>(text);
  if (!parsed) return null;

  const accountId =
    typeof parsed.account_id === "string" && accounts.some((a) => a.id === parsed.account_id)
      ? parsed.account_id
      : null;
  const accountName = accountId
    ? (accounts.find((a) => a.id === accountId)?.name ?? null)
    : (typeof parsed.account_name === "string" ? parsed.account_name.slice(0, 200) : null);
  return {
    accountId,
    accountName,
    confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
  };
}
