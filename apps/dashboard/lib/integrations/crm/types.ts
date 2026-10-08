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
// name, and ARR in integer cents. arrCents is null when no ARR field is
// chosen, and the sync then leaves Crumb's ARR alone.
export type CrmCompany = {
  externalId: string;
  name: string;
  arrCents: number | null;
};

// A number or currency field the ARR picker offers: API name + display label.
export type CrmField = { name: string; label: string };

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
  // The CRM field that holds ARR, already passed through safeFieldName, or
  // null when none is chosen. Never a guess: the stock annual-revenue fields
  // hold the customer company's own revenue, not what it pays you. An admin
  // picks it after connecting (workspaces.<provider>_arr_field).
  arrField(workspace: Workspace): string | null;
  // The company's number and currency fields, for that picker. Throws when
  // the CRM fails; IntegrationAuthError when it revoked Crumb's access.
  numberFields(workspace: Workspace): Promise<CrmField[]>;
  // Every company, one page at a time, refreshing the access token as needed
  // (and persisting it). A page that still fails after its retry throws, so a
  // sweep that stops partway is reported instead of passing for a full sync.
  companyPages(workspace: Workspace, arrField: string | null): AsyncGenerator<CrmCompany[]>;
}

// A chosen field name ends up in a SOQL query and a URL: plain API names only.
export function safeFieldName(name: string | null | undefined): string | null {
  const n = name?.trim();
  return n && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(n) ? n : null;
}

// arr_cents is bigint. The cap only keeps an absurd CRM value exact in JS.
export const MAX_ARR_CENTS = Number.MAX_SAFE_INTEGER;

export function dollarsToArrCents(dollars: unknown): number {
  const n = typeof dollars === "string" ? Number(dollars) : dollars;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_ARR_CENTS, Math.round(n * 100));
}

const RETRY_MS = 1000;
const TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry for a rate limit, a 5xx, a network error or a 30s timeout. Any
// other response is the caller's to judge. Honors Retry-After (seconds) up to
// 10s. The timeout keeps a hung CRM from holding a sync open.
export async function fetchWithRetry(url: string | URL, init?: RequestInit): Promise<Response> {
  const attempt = () => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  try {
    const resp = await attempt();
    if (resp.status !== 429 && resp.status < 500) return resp;
    const after = Number(resp.headers.get("retry-after"));
    await sleep(after > 0 ? Math.min(after, 10) * 1000 : RETRY_MS);
  } catch {
    await sleep(RETRY_MS);
  }
  return attempt();
}
