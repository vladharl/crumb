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

// What an adapter reads off a connection: the saved row, or the unsaved form
// values when estimating at connect time (open() passes plaintext through).
export type ConnectionCreds = Pick<IntegrationConnection, "workspaceId" | "accessToken" | "refreshToken" | "config">;

export interface FeedbackAdapter {
  readonly provider: FeedbackProvider;
  // Whether this provider can be offered for connection in this deployment.
  // Connection-token providers are always available (BYO token on self-host);
  // OAuth providers require their app creds in the environment.
  configured(): boolean;
  // Pull one page of records updated after `cursor`. "Nothing new" is an empty
  // page with done=true; every failure throws a FeedbackSyncError, so a failed
  // pull can never pass for a quiet success.
  listSince(conn: ConnectionCreds, cursor: string | null): Promise<FeedbackPage>;
  // How many records changed since `since`, for the connect-time estimate.
  // Only on providers that can count in one cheap call.
  count?(conn: ConnectionCreds, since: Date): Promise<number>;
}

// How far back the first sync reaches is chosen at connect time and written as
// the starting cursor (an ISO timestamp). A connection made before that choice
// existed has no cursor and falls back to DEFAULT_LOOKBACK_DAYS.
export const LOOKBACK_CHOICES = [0, 7, 30, 90] as const;
export const DEFAULT_LOOKBACK_DAYS = 7;

export function lookbackStart(days: number = DEFAULT_LOOKBACK_DAYS): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// The cursor as an ISO timestamp (Freshdesk, Freshchat, Gong).
export function cursorIso(cursor: string | null): string {
  return cursor ?? lookbackStart().toISOString();
}

// The cursor as unix seconds (Zendesk, Intercom). Their own cursors are unix
// seconds; the connect-time starting cursor is ISO.
export function cursorSeconds(cursor: string | null): number {
  if (cursor && /^\d+$/.test(cursor)) return Number(cursor);
  return Math.floor(Date.parse(cursorIso(cursor)) / 1000);
}

export function readConfig(conn: ConnectionCreds): ConnectionConfig {
  return (conn.config as ConnectionConfig | null) ?? {};
}

// ─── failures ──────────────────────────────────────────────────
// Why a pull failed. Stored in integration_connections.error and turned into a
// sentence by the settings card; never shown raw.
//   auth       401/403: the provider rejected the credentials. Reconnect.
//   config     any other refusal (404, 422, a redirect) or settings that can't
//              work. Fix them and reconnect.
//   transient  timeout, network error, 408/429/5xx. Retried with backoff.
export type SyncFailure = "auth" | "config" | "transient";

export class FeedbackSyncError extends Error {
  readonly reason: SyncFailure;
  // The HTTP status when the provider answered with one (vendorFetch).
  readonly status: number | null;
  constructor(reason: SyncFailure, detail: string = reason, status: number | null = null) {
    super(detail);
    this.name = "FeedbackSyncError";
    this.reason = reason;
    this.status = status;
  }
}

export function failureForStatus(status: number): SyncFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "config";
}

const FETCH_TIMEOUT_MS = 30_000;

// Every vendor request goes through here: redirects off (see the host guards
// below), a timeout so a hung provider can't hold the sync, and anything but a
// 2xx thrown as a FeedbackSyncError.
export async function vendorFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new FeedbackSyncError("transient", String(err));
  }
  if (!resp.ok) throw new FeedbackSyncError(failureForStatus(resp.status), `HTTP ${resp.status}`, resp.status);
  return resp;
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
