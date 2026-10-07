import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, accounts, type Workspace } from "@crumb/db";
import { integrationsAllowed } from "@/lib/entitlements";
import { IntegrationAuthError } from "../revoke";
import { getCrmAdapter } from "./index";
import type { CrmCompany, CrmProvider } from "./types";
import { log } from "@/lib/log";

// Why a sync didn't complete. The settings card maps each to a sentence.
//   plan_required   the plan no longer includes integrations: sync is paused
//   not_configured  this deployment has no OAuth app for the provider
//   disconnected    the CRM revoked Crumb's access and the install was cleared
//   partial         some pages synced, then the CRM stopped answering
//   failed          nothing synced
export type SyncError = "plan_required" | "not_configured" | "disconnected" | "partial" | "failed";

export type SyncResult =
  | { ok: true; upserted: number; arrSynced: boolean }
  | { ok: false; error: SyncError; upserted: number };

type LastRun = { ok: boolean; error: SyncError | null; at: Date };

// ponytail: in-process run state: one sync per workspace + CRM at a time, and
// the last outcome for the settings card. One dashboard process is the
// deployment shape, so a restart only forgets the last outcome. Move it to a
// column if instances multiply. Kept on globalThis so route handlers and
// server actions (separately bundled) share one copy.
const g = globalThis as typeof globalThis & {
  __crumbCrmSync?: { running: Map<string, Promise<SyncResult>>; last: Map<string, LastRun> };
};
const runs = (g.__crumbCrmSync ??= { running: new Map(), last: new Map() });

export function crmSyncState(workspaceId: string, provider: CrmProvider): { running: boolean; last: LastRun | null } {
  const key = `${workspaceId}:${provider}`;
  return { running: runs.running.has(key), last: runs.last.get(key) ?? null };
}

// One-way CRM → Crumb sync, the single path behind Sync now, the cron and the
// first sync after connecting. Pages through every company and reconciles it
// into `accounts`:
//   1. already linked (same provider + external id) → refresh name + ARR
//   2. an unlinked account with the same name → link it (no duplicate)
//   3. otherwise → insert a new CRM-sourced account
// Manually curated ARR (arr_source='manual') is never overwritten, and ARR is
// left alone entirely while no ARR field is chosen. A second call while a sync
// runs joins it instead of starting another. Never rejects.
export function syncCrmAccounts(workspace: Workspace, provider: CrmProvider): Promise<SyncResult> {
  if (!integrationsAllowed(workspace)) return Promise.resolve({ ok: false, error: "plan_required", upserted: 0 });
  if (!getCrmAdapter(provider).configured()) return Promise.resolve({ ok: false, error: "not_configured", upserted: 0 });

  const key = `${workspace.id}:${provider}`;
  const inFlight = runs.running.get(key);
  if (inFlight) return inFlight;
  const run = sweep(workspace, provider)
    .then((r) => {
      runs.last.set(key, { ok: r.ok, error: r.ok ? null : r.error, at: new Date() });
      return r;
    })
    .finally(() => runs.running.delete(key));
  runs.running.set(key, run);
  return run;
}

const nameKey = (name: string) => name.trim().toLowerCase();

async function sweep(workspace: Workspace, provider: CrmProvider): Promise<SyncResult> {
  const adapter = getCrmAdapter(provider);
  const arrField = adapter.arrField(workspace);
  let upserted = 0;
  try {
    const existing = await db
      .select({ id: accounts.id, name: accounts.name, extProvider: accounts.externalCrmProvider, extId: accounts.externalCrmId })
      .from(accounts)
      .where(eq(accounts.workspaceId, workspace.id));
    const seen = new Set<string>();
    const unlinkedByName = new Map<string, string>();
    for (const a of existing) {
      if (a.extProvider === provider && a.extId) seen.add(a.extId);
      if (!a.extId && !unlinkedByName.has(nameKey(a.name))) unlinkedByName.set(nameKey(a.name), a.id);
    }
    for await (const page of adapter.companyPages(workspace, arrField)) {
      upserted += await upsertPage(workspace.id, provider, page, arrField !== null, seen, unlinkedByName);
    }
  } catch (err) {
    if (err instanceof IntegrationAuthError) return { ok: false, error: "disconnected", upserted };
    log.error("crm sync failed", { scope: `crumb/${provider}`, workspaceId: workspace.id, upserted, err });
    return { ok: false, error: upserted > 0 ? "partial" : "failed", upserted };
  }
  return { ok: true, upserted, arrSynced: arrField !== null };
}

// Links the page's name matches, then writes the whole page as one upsert on
// the CRM key (accounts_crm_uniq). Returns how many companies it wrote.
async function upsertPage(
  workspaceId: string,
  provider: CrmProvider,
  page: CrmCompany[],
  syncArr: boolean,
  seen: Set<string>,
  unlinkedByName: Map<string, string>,
): Promise<number> {
  const byId = new Map(page.map((c) => [c.externalId, c]));
  for (const c of byId.values()) {
    if (seen.has(c.externalId)) continue;
    seen.add(c.externalId);
    const accountId = unlinkedByName.get(nameKey(c.name));
    if (!accountId) continue;
    unlinkedByName.delete(nameKey(c.name)); // one account per company
    await db
      .update(accounts)
      .set({ externalCrmProvider: provider, externalCrmId: c.externalId })
      .where(and(eq(accounts.id, accountId), isNull(accounts.externalCrmId)));
  }
  if (byId.size === 0) return 0;

  const now = new Date();
  await db
    .insert(accounts)
    .values([...byId.values()].map((c) => ({
      workspaceId,
      name: c.name,
      arrCents: c.arrCents ?? 0,
      arrSource: "crm",
      externalCrmProvider: provider,
      externalCrmId: c.externalId,
      crmSyncedAt: now,
    })))
    .onConflictDoUpdate({
      target: [accounts.workspaceId, accounts.externalCrmProvider, accounts.externalCrmId],
      set: {
        name: sql`excluded.name`,
        crmSyncedAt: now,
        ...(syncArr
          ? {
              arrCents: sql`CASE WHEN ${accounts.arrSource} = 'manual' THEN ${accounts.arrCents} ELSE excluded.arr_cents END`,
              arrSource: sql`CASE WHEN ${accounts.arrSource} = 'manual' THEN 'manual' ELSE 'crm' END`,
            }
          : {}),
      },
    });
  return byId.size;
}
