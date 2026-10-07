"use server";

import { getActiveSession } from "@/lib/server";
import { integrationsAllowed } from "@/lib/entitlements";
import { crmSyncState, type SyncError } from "./sync";
import type { CrmProvider } from "./types";

export type CrmCardStatus = {
  // A sync is in progress: the first one after connecting, Sync now or the cron.
  running: boolean;
  // The plan no longer includes integrations, so syncing is paused.
  paused: boolean;
  // How the latest sync in this process failed, if it did.
  lastError: SyncError | null;
  lastAt: string | null;
};

// What the CRM settings card shows beyond the server-rendered counts. The card
// polls this while a sync runs and refreshes itself when it ends.
export async function getCrmCardStatus(provider: CrmProvider): Promise<CrmCardStatus> {
  if (provider !== "hubspot" && provider !== "salesforce") throw new Error("unknown_provider");
  const { workspace } = await getActiveSession();
  const { running, last } = crmSyncState(workspace.id, provider);
  return {
    running,
    paused: !integrationsAllowed(workspace),
    lastError: last && !last.ok ? last.error : null,
    lastAt: last ? last.at.toISOString() : null,
  };
}
