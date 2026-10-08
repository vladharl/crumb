import "server-only";

// Community-edition stub for lib/ai/ticket.ts — aliased in when CRUMB_EDITION
// != cloud so the aistack client never enters the bundle. Mirrors the self-host
// runtime (ticketSuggestionConfigured() === false; suggestTicket() === null).

export const TICKET_MODEL = "qwen-35b-8bit";

export type TicketImpact = {
  accountName: string;
  arrCents: number;
  accounts: number;
  combinedArrCents: number;
  requesters: number;
  threadUrl: string | null;
};

export type SuggestTicketInput = {
  provider: "linear" | "jira" | "github";
  item: { title: string; body: string; type: string };
  recentTickets: Array<{ identifier: string; title: string; stateName: string }>;
  repoContext?: {
    repo: string;
    readme: string | null;
    topLevelTree: string | null;
  };
  impact?: TicketImpact;
};

export type SuggestTicketResult = {
  title: string;
  body: string;
  labels: string[] | null;
  reason: string;
  confidence: number;
};

export function ticketSuggestionConfigured(): boolean {
  return false;
}

export async function suggestTicket(_input: SuggestTicketInput): Promise<SuggestTicketResult | null> {
  return null;
}
