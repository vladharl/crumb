import "server-only";
import { and, eq } from "drizzle-orm";
import { db, integrationConnections } from "@crumb/db";
import { seal } from "@/lib/crypto-at-rest";
import type { ConnectionConfig, FeedbackProvider } from "./types";

// CRUD for inbound feedback connections (Autopilot). Tokens are sealed at rest;
// only the non-secret config (subdomain/domain/base URL) round-trips to the UI.

export type ConnectionView = {
  provider: FeedbackProvider;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  config: ConnectionConfig;
};

export async function listConnections(workspaceId: string): Promise<ConnectionView[]> {
  const rows = await db
    .select({
      provider: integrationConnections.provider,
      status: integrationConnections.status,
      lastSyncedAt: integrationConnections.lastSyncedAt,
      error: integrationConnections.error,
      config: integrationConnections.config,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.workspaceId, workspaceId));
  return rows.map((r) => ({
    provider: r.provider as FeedbackProvider,
    status: r.status,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.error,
    config: (r.config as ConnectionConfig | null) ?? {},
  }));
}

// Create or replace a connection. Updates creds + config + status, preserving the
// sync cursor across a re-connect (so a token refresh doesn't re-pull history).
// A new connection starts at `startCursor`: the first sync's window, chosen at
// connect time. Replacing config also drops the sync's claim and failure streak
// (see sync.ts), so a reconnect starts clean.
export async function upsertConnection(
  workspaceId: string,
  provider: FeedbackProvider,
  input: { accessToken?: string | null; refreshToken?: string | null; config?: ConnectionConfig },
  startCursor: string,
): Promise<void> {
  const accessToken = input.accessToken ? seal(input.accessToken) : null;
  const refreshToken = input.refreshToken ? seal(input.refreshToken) : null;
  await db
    .insert(integrationConnections)
    .values({ workspaceId, provider, accessToken, refreshToken, config: input.config ?? {}, status: "active", syncCursor: startCursor })
    .onConflictDoUpdate({
      target: [integrationConnections.workspaceId, integrationConnections.provider],
      set: { accessToken, refreshToken, config: input.config ?? {}, status: "active", error: null, updatedAt: new Date() },
    });
}

export async function removeConnection(workspaceId: string, provider: FeedbackProvider): Promise<void> {
  await db
    .delete(integrationConnections)
    .where(and(eq(integrationConnections.workspaceId, workspaceId), eq(integrationConnections.provider, provider)));
}
