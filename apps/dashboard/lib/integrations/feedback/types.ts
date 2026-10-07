import "server-only";
import type { IntegrationConnection } from "@crumb/db";

// Shared abstraction for inbound feedback connectors (Autopilot): pull records
// from a support/sales platform on a cursor, normalize them, and hand them to
// the gate in lib/feedback/ingest.ts. Mirrors the CRM adapter shape
// (lib/integrations/crm/types.ts) but pulls *records to extract* rather than
// *accounts to reconcile*.

export type FeedbackProvider = "gong" | "zendesk" | "intercom" | "freshdesk" | "freshchat";

// One pulled record (a ticket, a chat conversation, a call), normalized to the
// minimum the extraction gate needs. `text` is the full content to extract from;
// `url` deep-links back to the source; `raw` is provider metadata stashed on the
// capture's raw_meta for debugging/audit.
export type FeedbackRecord = {
  externalId: string;
  authorEmail: string | null;
  authorName: string | null;
  subject: string | null;
  text: string;
  url: string | null;
  occurredAt: Date | null;
  raw?: Record<string, unknown>;
};

export type FeedbackPage = {
  records: FeedbackRecord[];
  // Provider-defined cursor to persist and pass to the next listSince (an ISO
  // timestamp, a unix end_time, an incremental token…). null = leave unchanged.
  nextCursor: string | null;
  // True when there is nothing newer to fetch — the sync loop stops paging.
  done: boolean;
};

// Non-secret per-connection configuration stored in integration_connections.config.
export type ConnectionConfig = {
  subdomain?: string; // zendesk: <subdomain>.zendesk.com
  domain?: string; // freshdesk: <domain>.freshdesk.com
  baseUrl?: string; // gong / freshchat: API base URL
  email?: string; // zendesk: agent email for token auth
  region?: string; // freshchat: data-center region
};

export interface FeedbackAdapter {
  readonly provider: FeedbackProvider;
  // Whether this provider can be offered for connection in this deployment.
  // Connection-token providers are always available (BYO token on self-host);
  // OAuth providers require their app creds in the environment.
  configured(): boolean;
  // Pull one page of records updated after `cursor` (null = first sync). Reads
  // sealed creds off the connection. Never throws on "nothing new" — returns an
  // empty page with done=true.
  listSince(conn: IntegrationConnection, cursor: string | null): Promise<FeedbackPage>;
}

// First-sync lookback so a brand-new connection doesn't try to pull all history.
export const DEFAULT_LOOKBACK_DAYS = 90;

export function lookbackStart(days = DEFAULT_LOOKBACK_DAYS): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function readConfig(conn: IntegrationConnection): ConnectionConfig {
  return (conn.config as ConnectionConfig | null) ?? {};
}

// ─── outbound host guards ──────────────────────────────────────
// Each pull carries the workspace's vendor credentials to a host built from
// admin-typed config, so that config must not be able to steer the request
// anywhere else ("evil.com/x?" as a Zendesk subdomain would otherwise send the
// API token to evil.com; on Cloud an internal host would be an SSRF). Adapters
// also fetch with redirect: "manual" so a 30x can't bounce them off-host.

// A bare DNS label: the "acme" of acme.zendesk.com / acme.freshdesk.com.
export function vendorSubdomain(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? s : null;
}

// An https URL on `apex` or a subdomain of it, default port. Returns origin +
// path without a trailing slash (ready for `${base}/endpoint`), else null.
export function vendorBaseUrl(raw: string | undefined, apex: string): string | null {
  let u: URL;
  try { u = new URL((raw ?? "").trim()); } catch { return null; }
  const onApex = u.hostname === apex || u.hostname.endsWith(`.${apex}`);
  if (u.protocol !== "https:" || !onApex || u.port) return null;
  return u.origin + u.pathname.replace(/\/+$/, "");
}
