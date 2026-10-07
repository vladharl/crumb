"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, integrationConnections } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { integrationsAllowed } from "@/lib/entitlements";
import { getFeedbackAdapter, isFeedbackProvider } from "@/lib/integrations/feedback";
import { listConnections, upsertConnection, removeConnection } from "@/lib/integrations/feedback/connections";
import { MANUAL_RUN_BUDGET_MS, syncFeedbackSource } from "@/lib/integrations/feedback/sync";
import {
  DEFAULT_LOOKBACK_DAYS, FeedbackSyncError, LOOKBACK_CHOICES, lookbackStart, vendorBaseUrl, vendorSubdomain,
  type ConnectionConfig, type FeedbackProvider,
} from "@/lib/integrations/feedback/types";
import type { IngestOutcome } from "@/lib/feedback/ingest";

// Errors are codes (FeedbackConnectors.tsx words them): unknown_provider,
// forbidden, not_entitled, missing_fields, invalid_host, not_connected,
// sync_running, and the sync failures auth | config | transient.
export type ConnectorResult = { ok: true; message?: string } | { ok: false; error: string };

// Flat form fields from the UI → (sealed creds + non-secret config) per
// provider. Hosts are checked here too, so a typo fails at connect time instead
// of on the first sync.
function mapFields(
  provider: FeedbackProvider,
  f: Record<string, string>,
): { accessToken?: string | null; refreshToken?: string | null; config: ConnectionConfig } | { error: string } {
  const v = (k: string) => (f[k] ?? "").trim();
  switch (provider) {
    case "gong":
      if (!v("accessKey") || !v("accessKeySecret")) return { error: "missing_fields" };
      if (v("baseUrl") && !vendorBaseUrl(v("baseUrl"), "api.gong.io")) return { error: "invalid_host" };
      return { accessToken: v("accessKey"), refreshToken: v("accessKeySecret"), config: { baseUrl: v("baseUrl") || undefined } };
    case "zendesk":
      if (!v("subdomain") || !v("email") || !v("apiToken")) return { error: "missing_fields" };
      if (!vendorSubdomain(v("subdomain"))) return { error: "invalid_host" };
      return { accessToken: v("apiToken"), config: { subdomain: v("subdomain"), email: v("email") } };
    case "freshdesk":
      if (!v("domain") || !v("apiKey")) return { error: "missing_fields" };
      if (!vendorSubdomain(v("domain"))) return { error: "invalid_host" };
      return { accessToken: v("apiKey"), config: { domain: v("domain") } };
    case "intercom":
      if (!v("accessToken")) return { error: "missing_fields" };
      return { accessToken: v("accessToken"), config: {} };
    case "freshchat":
      if (!v("baseUrl") || !v("apiToken")) return { error: "missing_fields" };
      if (!vendorBaseUrl(v("baseUrl"), "freshchat.com")) return { error: "invalid_host" };
      return { accessToken: v("apiToken"), config: { baseUrl: v("baseUrl") } };
    default:
      return { error: "unknown_provider" };
  }
}

// Admins only. Connecting and syncing also need the plan; disconnecting never
// does, so a downgraded workspace can still remove what it connected.
async function gate(needsPlan = true) {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false as const, error: "forbidden" };
  if (needsPlan && !integrationsAllowed(workspace)) return { ok: false as const, error: "not_entitled" };
  return { ok: true as const, workspace };
}

// Where the first sync starts: `days` back from now (one of LOOKBACK_CHOICES,
// else the default), as the ISO cursor the adapters read.
function firstSyncStart(days: number | undefined): Date {
  const choices: readonly number[] = LOOKBACK_CHOICES;
  return lookbackStart(days !== undefined && choices.includes(days) ? days : DEFAULT_LOOKBACK_DAYS);
}

export async function connectFeedbackSource(
  provider: string,
  fields: Record<string, string>,
  lookbackDays?: number,
): Promise<ConnectorResult> {
  if (!isFeedbackProvider(provider)) return { ok: false, error: "unknown_provider" };
  const g = await gate();
  if (!g.ok) return g;

  const mapped = mapFields(provider, fields);
  if ("error" in mapped) return { ok: false, error: mapped.error };

  // The start only applies to a new connection; a reconnect keeps its cursor.
  await upsertConnection(g.workspace.id, provider, mapped, firstSyncStart(lookbackDays).toISOString());
  revalidatePath("/settings/integrations");
  return { ok: true, message: "Connected. Feedback will sync on the next pull." };
}

// Before a first connect: check the credentials and count what the chosen
// window would pull, on providers that can count in one cheap call. Saves
// nothing. count is null when the provider can't count or didn't answer.
export async function estimateFeedbackBacklog(
  provider: string,
  fields: Record<string, string>,
  lookbackDays: number,
): Promise<{ ok: true; count: number | null } | { ok: false; error: string }> {
  if (!isFeedbackProvider(provider)) return { ok: false, error: "unknown_provider" };
  const g = await gate();
  if (!g.ok) return g;

  const mapped = mapFields(provider, fields);
  if ("error" in mapped) return { ok: false, error: mapped.error };
  const adapter = getFeedbackAdapter(provider);
  if (!adapter.count) return { ok: true, count: null };

  // Unsaved, so the creds are plaintext; open() passes those through.
  const creds = {
    workspaceId: g.workspace.id,
    accessToken: mapped.accessToken ?? null,
    refreshToken: mapped.refreshToken ?? null,
    config: mapped.config,
  };
  try {
    return { ok: true, count: await adapter.count(creds, firstSyncStart(lookbackDays)) };
  } catch (err) {
    // A refused token or account is worth stopping for; a slow provider isn't.
    if (err instanceof FeedbackSyncError && err.reason !== "transient") return { ok: false, error: err.reason };
    return { ok: true, count: null };
  }
}

export async function disconnectFeedbackSource(provider: string): Promise<ConnectorResult> {
  if (!isFeedbackProvider(provider)) return { ok: false, error: "unknown_provider" };
  const g = await gate(false);
  if (!g.ok) return g;
  await removeConnection(g.workspace.id, provider);
  revalidatePath("/settings/integrations");
  return { ok: true };
}

function syncMessage(o: IngestOutcome, more: boolean): string {
  const parts = ([
    [o.promoted, "added"],
    [o.attached, "merged into existing items"],
    [o.held, "waiting in the Inbox"],
    [o.dropped, "not product feedback"],
  ] as const).filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const done = parts.length ? `Synced: ${parts.join(", ")}.` : "Up to date. Nothing new since the last sync.";
  return more ? `${done} More will sync on the next run.` : done;
}

// Manual one-off pull — handy for testing without waiting for the cron. Kept
// short so the request answers; `more` says the rest comes on the next run.
export async function syncFeedbackNow(provider: string): Promise<ConnectorResult> {
  if (!isFeedbackProvider(provider)) return { ok: false, error: "unknown_provider" };
  const g = await gate();
  if (!g.ok) return g;

  const [conn] = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.workspaceId, g.workspace.id), eq(integrationConnections.provider, provider)))
    .limit(1);
  if (!conn) return { ok: false, error: "not_connected" };

  const r = await syncFeedbackSource(g.workspace, conn, MANUAL_RUN_BUDGET_MS);
  revalidatePath("/settings/integrations");
  revalidatePath("/inbox");
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message: syncMessage(r.outcome, r.more) };
}

export async function listFeedbackConnections() {
  const { workspace } = await getActiveSession();
  return listConnections(workspace.id);
}
