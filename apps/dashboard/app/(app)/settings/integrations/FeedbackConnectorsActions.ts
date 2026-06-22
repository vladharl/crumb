"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, integrationConnections } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { integrationsAllowed } from "@/lib/entitlements";
import { isFeedbackProvider } from "@/lib/integrations/feedback";
import { listConnections, upsertConnection, removeConnection } from "@/lib/integrations/feedback/connections";
import { syncFeedbackSource } from "@/lib/integrations/feedback/sync";
import type { ConnectionConfig, FeedbackProvider } from "@/lib/integrations/feedback/types";

export type ConnectorResult = { ok: true; message?: string } | { ok: false; error: string };

// Flat form fields from the UI → (sealed creds + non-secret config) per provider.
function mapFields(
  provider: FeedbackProvider,
  f: Record<string, string>,
): { accessToken?: string | null; refreshToken?: string | null; config: ConnectionConfig } | { error: string } {
  const v = (k: string) => (f[k] ?? "").trim();
  switch (provider) {
    case "gong":
      if (!v("accessKey") || !v("accessKeySecret")) return { error: "missing_fields" };
      return { accessToken: v("accessKey"), refreshToken: v("accessKeySecret"), config: { baseUrl: v("baseUrl") || undefined } };
    case "zendesk":
      if (!v("subdomain") || !v("email") || !v("apiToken")) return { error: "missing_fields" };
      return { accessToken: v("apiToken"), config: { subdomain: v("subdomain"), email: v("email") } };
    case "freshdesk":
      if (!v("domain") || !v("apiKey")) return { error: "missing_fields" };
      return { accessToken: v("apiKey"), config: { domain: v("domain") } };
    case "intercom":
      if (!v("accessToken")) return { error: "missing_fields" };
      return { accessToken: v("accessToken"), config: {} };
    case "freshchat":
      if (!v("baseUrl") || !v("apiToken")) return { error: "missing_fields" };
      return { accessToken: v("apiToken"), config: { baseUrl: v("baseUrl") } };
    default:
      return { error: "unknown_provider" };
  }
}

async function gate() {
  const { workspace, user } = await getActiveSession();
  if (user.role !== "admin") return { ok: false as const, error: "forbidden" };
  if (!integrationsAllowed(workspace)) return { ok: false as const, error: "not_entitled" };
  return { ok: true as const, workspace };
}

export async function connectFeedbackSource(provider: string, fields: Record<string, string>): Promise<ConnectorResult> {
  if (!isFeedbackProvider(provider)) return { ok: false, error: "unknown_provider" };
  const g = await gate();
  if (!g.ok) return g;

  const mapped = mapFields(provider, fields);
  if ("error" in mapped) return { ok: false, error: mapped.error };

  await upsertConnection(g.workspace.id, provider, mapped);
  revalidatePath("/settings/integrations");
  return { ok: true, message: "Connected. Feedback will sync on the next pull." };
}

export async function disconnectFeedbackSource(provider: string): Promise<ConnectorResult> {
  if (!isFeedbackProvider(provider)) return { ok: false, error: "unknown_provider" };
  const g = await gate();
  if (!g.ok) return g;
  await removeConnection(g.workspace.id, provider);
  revalidatePath("/settings/integrations");
  return { ok: true };
}

// Manual one-off pull — handy for testing without waiting for the cron.
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

  const r = await syncFeedbackSource(g.workspace, conn);
  revalidatePath("/settings/integrations");
  revalidatePath("/inbox");
  if (!r.ok) return { ok: false, error: r.error };
  const o = r.outcome;
  return { ok: true, message: `Pulled ${r.pulled} — ${o.promoted} added, ${o.attached} merged, ${o.held} to review, ${o.dropped} dropped.` };
}

export async function listFeedbackConnections() {
  const { workspace } = await getActiveSession();
  return listConnections(workspace.id);
}
