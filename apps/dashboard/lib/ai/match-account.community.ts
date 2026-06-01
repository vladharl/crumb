import "server-only";

// Community-edition stub for lib/ai/match-account.ts — account suggestion is
// Cloud-only. Captures still land (pending) on self-host, just without a
// suggested account for the vendor to confirm.

export const MATCH_ACCOUNT_MODEL = "qwen-35b-8bit";

export type AccountChoice = { id: string; name: string };
export type AccountSuggestion = { accountId: string | null; accountName: string | null; confidence: number };

export function matchAccountConfigured(): boolean {
  return false;
}

export async function suggestAccount(
  _input: { fromEmail: string | null; fromName: string | null; subject: string | null; body: string },
  _accounts: AccountChoice[],
): Promise<AccountSuggestion | null> {
  return null;
}
