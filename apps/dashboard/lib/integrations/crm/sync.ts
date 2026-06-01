import "server-only";
import { eq } from "drizzle-orm";
import { db, accounts, type Workspace } from "@crumb/db";
import { getCrmAdapter } from "./index";
import type { CrmProvider } from "./types";
import { log } from "@/lib/log";

export type SyncResult = { ok: true; upserted: number } | { ok: false; error: string };

// One-way CRM → Crumb sync. Pulls companies + ARR and reconciles them into
// `accounts`:
//   1. already-linked (same provider + external id) → refresh name + ARR
//   2. an unlinked account with the same name → link it (no duplicate)
//   3. otherwise → insert a new CRM-sourced account
// Manually-curated ARR (arr_source='manual') is never overwritten — only the
// name/link/synced-time refresh. New + CRM-sourced rows carry arr_source='crm'.
export async function syncCrmAccounts(
  workspace: Workspace,
  provider: CrmProvider,
): Promise<SyncResult> {
  const adapter = getCrmAdapter(provider);
  if (!adapter.configured()) return { ok: false, error: `${provider}_not_configured` };

  let companies;
  try {
    companies = await adapter.listCompaniesWithArr(workspace);
  } catch (err) {
    log.error("crm sync fetch failed", { scope: `crumb/${provider}`, err });
    return { ok: false, error: "fetch_failed" };
  }

  const existing = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      arrSource: accounts.arrSource,
      extProvider: accounts.externalCrmProvider,
      extId: accounts.externalCrmId,
    })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspace.id));

  const byCrmId = new Map<string, (typeof existing)[number]>();
  const unlinkedByName = new Map<string, (typeof existing)[number]>();
  for (const a of existing) {
    if (a.extProvider === provider && a.extId) byCrmId.set(a.extId, a);
    if (!a.extId) {
      const k = a.name.trim().toLowerCase();
      if (!unlinkedByName.has(k)) unlinkedByName.set(k, a);
    }
  }

  const now = new Date();
  let upserted = 0;
  for (const c of companies) {
    const linked = byCrmId.get(c.externalId);
    if (linked) {
      await db
        .update(accounts)
        .set({
          name: c.name,
          crmSyncedAt: now,
          ...(linked.arrSource === "manual" ? {} : { arrCents: c.arrCents, arrSource: "crm" }),
        })
        .where(eq(accounts.id, linked.id));
      upserted++;
      continue;
    }

    const nameKey = c.name.trim().toLowerCase();
    const match = unlinkedByName.get(nameKey);
    if (match) {
      await db
        .update(accounts)
        .set({
          externalCrmProvider: provider,
          externalCrmId: c.externalId,
          crmSyncedAt: now,
          ...(match.arrSource === "manual" ? {} : { arrCents: c.arrCents, arrSource: "crm" }),
        })
        .where(eq(accounts.id, match.id));
      unlinkedByName.delete(nameKey); // don't match two companies to one account
      upserted++;
      continue;
    }

    await db.insert(accounts).values({
      workspaceId: workspace.id,
      name: c.name,
      arrCents: c.arrCents,
      arrSource: "crm",
      externalCrmProvider: provider,
      externalCrmId: c.externalId,
      crmSyncedAt: now,
    });
    upserted++;
  }

  return { ok: true, upserted };
}
