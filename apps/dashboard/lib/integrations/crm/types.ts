import "server-only";
import type { Workspace } from "@crumb/db";

// Shared abstraction for one-way CRM → Crumb sync of accounts + ARR (feature 1).
// Each provider (HubSpot, Salesforce) implements CrmAdapter; lib/integrations/
// crm/sync.ts drives the upsert. Capability-gated like the other integrations:
// present OAuth-app creds ⇒ the provider shows up (works on self-host).

export type CrmProvider = "hubspot" | "salesforce";

export type CrmTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  // Salesforce: the per-org REST host. HubSpot: null.
  instanceUrl?: string | null;
  // HubSpot: the connected portal/hub id. Salesforce: null.
  portalId?: string | null;
};

// A CRM company mapped to what Crumb needs: a stable external id, a display
// name, and ARR already normalized to integer cents.
export type CrmCompany = {
  externalId: string;
  name: string;
  arrCents: number;
};

export interface CrmAdapter {
  readonly provider: CrmProvider;
  // True when this provider's OAuth-app creds are present in the environment.
  configured(): boolean;
  // Optional explicit redirect override (e.g. *_REDIRECT_URL); null = derive.
  redirectOverride(): string | null;
  // Build the provider's consent URL (HMAC-signed state via lib/integrations/state).
  buildAuthUrl(workspaceId: string, redirectUrl: string): string;
  // Exchange the auth code for tokens at the callback.
  exchangeCode(code: string, redirectUrl: string): Promise<CrmTokens>;
  // Pull every company with an ARR value, refreshing the access token as
  // needed (and persisting the refreshed token to the workspace row).
  listCompaniesWithArr(workspace: Workspace): Promise<CrmCompany[]>;
}

// ARR safety cap — mirrors accounts/actions.ts (avoid int overflow on a bad
// CRM value). $21M in cents.
export const MAX_ARR_CENTS = 2_100_000_000;

export function dollarsToArrCents(dollars: number | string | null | undefined): number {
  const n = typeof dollars === "string" ? Number(dollars) : dollars;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_ARR_CENTS, Math.round(n * 100));
}
