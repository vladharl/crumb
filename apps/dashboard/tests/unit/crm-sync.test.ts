import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, accounts, workspaces, type Workspace } from "@crumb/db";
import { syncCrmAccounts } from "@/lib/integrations/crm/sync";
import { getCrmAdapter } from "@/lib/integrations/crm";

// CRM sync: pages through the whole CRM (past HubSpot's old 2,000-company
// stop), stores enterprise ARR exactly from the field the admin chose, says
// when a sweep stopped partway, pauses on a plan without integrations, and
// only disconnects Salesforce when the refresh token itself is rejected
// (invalid_grant).
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`) with
// the CRM APIs stubbed. Skipped locally when no database answers; CI has one,
// so there it fails instead.

vi.mock("@/lib/email", () => ({ sendIntegrationDisconnected: vi.fn(async () => {}) }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const created: string[] = [];
async function workspace(values: Partial<typeof workspaces.$inferInsert>): Promise<Workspace> {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `crm-sync-${randomUUID().slice(0, 8)}`, name: "CRM sync test", ...values })
    .returning();
  created.push(ws.id);
  return ws;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("ARR field", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is the admin's pick; HUBSPOT_ARR_PROPERTY is only a self-host default", () => {
    const ws = { hubspotArrField: null, salesforceArrField: "ARR__c" } as Workspace;
    expect(getCrmAdapter("hubspot").arrField(ws)).toBeNull();
    expect(getCrmAdapter("salesforce").arrField(ws)).toBe("ARR__c");
    vi.stubEnv("HUBSPOT_ARR_PROPERTY", "arr");
    vi.stubEnv("CRUMB_TIER", "self_host");
    expect(getCrmAdapter("hubspot").arrField(ws)).toBe("arr");
    expect(getCrmAdapter("hubspot").arrField({ ...ws, hubspotArrField: "paid_arr" })).toBe("paid_arr");
    vi.stubEnv("CRUMB_TIER", "cloud");
    expect(getCrmAdapter("hubspot").arrField(ws)).toBeNull();
    // Never anything that isn't a plain API name: it lands in a query.
    expect(getCrmAdapter("salesforce").arrField({ ...ws, salesforceArrField: "Name FROM User--" })).toBeNull();
  });
});

describe.skipIf(!reachable && !process.env.CI)("CRM sync", () => {
  beforeAll(() => {
    vi.stubEnv("HUBSPOT_CLIENT_ID", "hs-id");
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", "hs-secret");
    vi.stubEnv("SALESFORCE_CLIENT_ID", "sf-id");
    vi.stubEnv("SALESFORCE_CLIENT_SECRET", "sf-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("HUBSPOT_ARR_PROPERTY", "");
    vi.stubEnv("CRUMB_TIER", "");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  const hubspotWs = (values: Partial<typeof workspaces.$inferInsert> = {}) => workspace({
    hubspotAccessToken: "hs-token",
    hubspotRefreshToken: "hs-refresh",
    hubspotTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    ...values,
  });

  // `pages` HubSpot pages of 100 companies; company 7 carries $50M of ARR.
  function hubspotPortal(pages: number, failPage?: number) {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      const page = Number(url.searchParams.get("after") ?? 0);
      if (page === failPage) return json({ message: "boom" }, 500);
      const results = Array.from({ length: 100 }, (_, i) => {
        const id = page * 100 + i;
        return { id: String(id), properties: { name: `Company ${id}`, arr: id === 7 ? "50000000" : "1200" } };
      });
      return json({ results, ...(page + 1 < pages ? { paging: { next: { after: String(page + 1) } } } : {}) });
    }));
    return calls;
  }

  it("pages past 2,000 HubSpot companies and keeps ARR above $21M exact", async () => {
    const ws = await hubspotWs({ hubspotArrField: "arr" });
    // An existing hand-entered account matches company 3 by name.
    await db.insert(accounts).values({ workspaceId: ws.id, name: "company 3", arrCents: 999, arrSource: "manual" });
    const calls = hubspotPortal(21);

    expect(await syncCrmAccounts(ws, "hubspot")).toEqual({ ok: true, upserted: 2100, arrSynced: true });
    expect(calls).toHaveLength(21);
    expect(calls[0].searchParams.get("properties")).toBe("name,arr");

    const rows = await db.select().from(accounts).where(eq(accounts.workspaceId, ws.id));
    expect(rows).toHaveLength(2100);
    const byId = new Map(rows.map((r) => [r.externalCrmId, r]));
    expect(byId.get("7")).toMatchObject({ arrCents: 5_000_000_000, arrSource: "crm", externalCrmProvider: "hubspot" });
    expect(byId.get("2099")).toMatchObject({ arrCents: 120_000 });
    // Linked by name, the manual ARR stays.
    expect(byId.get("3")).toMatchObject({ name: "Company 3", arrCents: 999, arrSource: "manual" });
  });

  it("leaves ARR alone while no ARR field is chosen", async () => {
    const ws = await hubspotWs();
    await db.insert(accounts).values({
      workspaceId: ws.id, name: "Company 1", arrCents: 4200, arrSource: "crm",
      externalCrmProvider: "hubspot", externalCrmId: "1",
    });
    const calls = hubspotPortal(1);

    expect(await syncCrmAccounts(ws, "hubspot")).toEqual({ ok: true, upserted: 100, arrSynced: false });
    expect(calls[0].searchParams.get("properties")).toBe("name");
    const [linked] = await db.select().from(accounts)
      .where(and(eq(accounts.workspaceId, ws.id), eq(accounts.externalCrmId, "1")));
    expect(linked.arrCents).toBe(4200);
  });

  it("reports a sweep that stopped partway instead of passing it off as done", async () => {
    vi.stubEnv("HUBSPOT_ARR_PROPERTY", "arr");
    const ws = await hubspotWs();
    hubspotPortal(5, 2);

    expect(await syncCrmAccounts(ws, "hubspot")).toEqual({ ok: false, error: "partial", upserted: 200 });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(accounts).where(eq(accounts.workspaceId, ws.id));
    expect(n).toBe(200);
    // Still connected: a 500 is not a revocation.
    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(after.hubspotAccessToken).toBe("hs-token");
  });

  it("is paused, without calling the CRM, on a Cloud plan without integrations", async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    const ws = await hubspotWs();
    const calls = hubspotPortal(1);

    expect(await syncCrmAccounts(ws, "hubspot")).toEqual({ ok: false, error: "plan_required", upserted: 0 });
    expect(calls).toHaveLength(0);
  });

  const salesforceWs = (values: Partial<typeof workspaces.$inferInsert> = {}) => workspace({
    salesforceAccessToken: "sf-old",
    salesforceRefreshToken: "sf-refresh",
    salesforceInstanceUrl: "https://acme.my.salesforce.test",
    ...values,
  });

  // A Salesforce org whose session expired: the first query 401s, then the
  // refresh endpoint answers with `refresh` in turn.
  function expiredSalesforce(refresh: Response[]) {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/services/oauth2/token")) return refresh.shift() ?? json({}, 500);
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer sf-new") return json([{ errorCode: "INVALID_SESSION_ID" }], 401);
      return json({ records: [{ Id: "001", Name: "Acme" }], done: true });
    }));
  }

  it("rides out a Salesforce token-endpoint outage instead of disconnecting", async () => {
    const ws = await salesforceWs();
    expiredSalesforce([json({ error: "server_error" }, 503), json({ access_token: "sf-new", instance_url: ws.salesforceInstanceUrl })]);

    expect(await syncCrmAccounts(ws, "salesforce")).toEqual({ ok: true, upserted: 1, arrSynced: false });
    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(after.salesforceAccessToken).toBe("sf-new");
    expect(after.integrationAlerts).toBeNull();
  });

  it("disconnects Salesforce, with an alert, only on invalid_grant", async () => {
    const ws = await salesforceWs({ salesforceArrField: "ARR__c" });
    expiredSalesforce([json({ error: "invalid_grant", error_description: "expired access/refresh token" }, 400)]);

    expect(await syncCrmAccounts(ws, "salesforce")).toEqual({ ok: false, error: "disconnected", upserted: 0 });
    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(after.salesforceAccessToken).toBeNull();
    expect(after.salesforceRefreshToken).toBeNull();
    expect(after.salesforceArrField).toBeNull(); // a reconnect may be another org
    expect(after.integrationAlerts?.salesforce?.reason).toBe("revoked");
  });
});
