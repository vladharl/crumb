import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, inboundCaptures, integrationConnections, usageCounters, workspaces, type IntegrationConnection, type Workspace } from "@crumb/db";
import { MAX_FAILURES, syncDue, syncFeedbackSource } from "@/lib/integrations/feedback/sync";
import { failureForStatus } from "@/lib/integrations/feedback/types";
import { gong } from "@/lib/integrations/feedback/gong";
import { createInboundCapture } from "@/lib/captures";
import { withAutopilotBudget } from "@/lib/feedback/ingest";
import { upsertConnection } from "@/lib/integrations/feedback/connections";

// Autopilot pulls fail loudly and recover on their own (audit #80): a refused
// token is an error state, an outage keeps the cursor and retries with backoff,
// overlapping runs skip, a record is captured once, and Autopilot's AI is
// metered apart from the AI suite's budget.

const MIN = 60_000;

describe("sync scheduling", () => {
  it("classifies provider responses and backs off between retries", () => {
    expect([401, 403, 404, 422, 302, 408, 429, 500, 503].map(failureForStatus)).toEqual(
      ["auth", "auth", "config", "config", "config", "transient", "transient", "transient", "transient"],
    );
    const at = new Date("2026-10-07T12:00:00Z").getTime();
    const conn = (status: string, error: string | null, failures: number) =>
      ({ status, error, config: failures ? { failures } : {}, updatedAt: new Date(at) });
    expect(syncDue(conn("active", null, 0), at)).toBe(true);
    expect(syncDue(conn("active", "transient", 1), at + 14 * MIN)).toBe(false);
    expect(syncDue(conn("active", "transient", 1), at + 15 * MIN)).toBe(true);
    expect(syncDue(conn("active", "transient", 3), at + 59 * MIN)).toBe(false);
    expect(syncDue(conn("active", "transient", 3), at + 60 * MIN)).toBe(true);
    // Past the streak limit it shows as an error but is still retried, at the cap.
    expect(syncDue(conn("error", "transient", 9), at + 359 * MIN)).toBe(false);
    expect(syncDue(conn("error", "transient", 9), at + 360 * MIN)).toBe(true);
    // A rejected token waits for the admin.
    expect(syncDue(conn("error", "auth", 1), at + 9999 * MIN)).toBe(false);
  });
});

// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];
const ENV = { tier: process.env.CRUMB_TIER, cap: process.env.CRUMB_AI_MONTHLY_CAP };

function respond(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function newWorkspace(): Promise<Workspace> {
  const [ws] = await db.insert(workspaces).values({ slug: `autopilot-${randomUUID().slice(0, 8)}`, name: "Acme" }).returning();
  created.push(ws!.id);
  return ws!;
}

describe.skipIf(!reachable && !process.env.CI)("feedback sync against Postgres", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ENV.tier === undefined) delete process.env.CRUMB_TIER; else process.env.CRUMB_TIER = ENV.tier;
    if (ENV.cap === undefined) delete process.env.CRUMB_AI_MONTHLY_CAP; else process.env.CRUMB_AI_MONTHLY_CAP = ENV.cap;
  });
  afterAll(async () => {
    if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("keeps the cursor through failures, skips a claimed connection, and captures a record once", async () => {
    const ws = await newWorkspace();
    const [conn] = await db.insert(integrationConnections).values({
      workspaceId: ws.id, provider: "zendesk", accessToken: "tok",
      config: { subdomain: "acme", email: "agent@acme.test" }, syncCursor: "1700000000",
    }).returning();
    const row = async () => (await db.select().from(integrationConnections).where(eq(integrationConnections.id, conn!.id)))[0]!;
    const sync = async () => syncFeedbackSource(ws, await row());

    // An outage: still active and retrying, nothing marked as synced.
    respond(503);
    expect(await sync()).toMatchObject({ ok: false, error: "transient" });
    let r = await row();
    expect(r).toMatchObject({ status: "active", error: "transient", syncCursor: "1700000000", lastSyncedAt: null });
    expect(r.config).toEqual({ subdomain: "acme", email: "agent@acme.test", failures: 1 });
    expect(syncDue(r)).toBe(false); // backing off

    // A long one: after MAX_FAILURES in a row it shows as an error.
    for (let i = 1; i < MAX_FAILURES; i++) await sync();
    expect(await row()).toMatchObject({ status: "error", error: "transient" });

    // A rejected token.
    respond(401);
    expect(await sync()).toMatchObject({ ok: false, error: "auth" });
    expect(await row()).toMatchObject({ status: "error", error: "auth", syncCursor: "1700000000" });

    // Another run holds the claim: skip without calling the provider. A claim
    // older than 30 minutes is a dead run's and may be taken over.
    const fetchMock = respond(200, {
      tickets: [{ id: 1, subject: "Export is broken", description: "CSV export 500s", requester_id: 7 }],
      users: [{ id: 7, email: "maya@globex.test", name: "Maya" }],
      end_time: 1700000100,
      end_of_stream: true,
    });
    const claimAt = (age: string) => db.update(integrationConnections)
      .set({ config: sql`${integrationConnections.config} || jsonb_build_object('syncingSince', now() - ${age}::interval)` })
      .where(eq(integrationConnections.id, conn!.id));
    await claimAt("1 minute");
    expect(await sync()).toMatchObject({ ok: false, error: "sync_running" });
    expect(fetchMock).not.toHaveBeenCalled();
    await claimAt("31 minutes");

    // Back up: healthy again, streak and claim cleared, cursor advanced.
    expect(await sync()).toMatchObject({ ok: true, pulled: 1, more: false, outcome: { held: 1 } });
    r = await row();
    expect(r).toMatchObject({ status: "active", error: null, syncCursor: "1700000100" });
    expect(r.lastSyncedAt).not.toBeNull();
    expect(r.config).toEqual({ subdomain: "acme", email: "agent@acme.test" });

    // The same record again: the insert is a no-op, and a re-sync skips it.
    const captures = () => db.select({ id: inboundCaptures.id }).from(inboundCaptures)
      .where(and(eq(inboundCaptures.workspaceId, ws.id), eq(inboundCaptures.externalId, "1#0")));
    expect(await createInboundCapture(ws, {
      source: "zendesk", fromEmail: null, fromName: null, subject: null, body: "dup", externalId: "1#0", suggestion: null,
    })).toBeNull();
    expect(await sync()).toMatchObject({ ok: true, outcome: { skipped: 1, held: 0 } });
    expect(await captures()).toHaveLength(1);
  });

  it("a reconnect keeps a running sync's claim and drops the failure streak", async () => {
    const ws = await newWorkspace();
    const claimed = "2026-10-07T12:00:00.000Z";
    await db.insert(integrationConnections).values({
      workspaceId: ws.id, provider: "freshdesk", accessToken: "old",
      config: { domain: "acme", syncingSince: claimed, failures: 3 }, syncCursor: "1700000000",
    });
    await upsertConnection(ws.id, "freshdesk", { accessToken: "new", config: { domain: "acme2" } }, "1800000000");
    const [r] = await db.select().from(integrationConnections)
      .where(and(eq(integrationConnections.workspaceId, ws.id), eq(integrationConnections.provider, "freshdesk")));
    expect(r!.config).toEqual({ domain: "acme2", syncingSince: claimed });
    expect(r!.syncCursor).toBe("1700000000"); // a reconnect keeps its place

    // No claim to keep: the new config is stored as given.
    await db.update(integrationConnections).set({ config: { domain: "acme2" } }).where(eq(integrationConnections.id, r!.id));
    await upsertConnection(ws.id, "freshdesk", { accessToken: "newer", config: { domain: "acme3" } }, "1800000000");
    const [r2] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, r!.id));
    expect(r2!.config).toEqual({ domain: "acme3" });
  });

  it("meters Autopilot apart from the AI suite's budget", async () => {
    process.env.CRUMB_TIER = "cloud";
    process.env.CRUMB_AI_MONTHLY_CAP = "2";
    const ws = { ...(await newWorkspace()), planId: "team", subscriptionStatus: "active" };
    const run = () => withAutopilotBudget(ws, async () => "ran");
    expect(await run()).toEqual({ ok: true, value: "ran" });
    expect(await run()).toEqual({ ok: true, value: "ran" });
    expect(await run()).toEqual({ ok: false, error: "ai_cap_reached" });
    const counters = await db.select({ metric: usageCounters.metric, count: usageCounters.count })
      .from(usageCounters).where(eq(usageCounters.workspaceId, ws.id));
    expect(counters).toEqual([{ metric: "autopilot_ai", count: 2 }]);
  });
});

// Gong answers a window with no calls with 404 instead of an empty list, and
// 404s transcripts it hasn't finished. Neither is a settings problem: the first
// is nothing new (connect estimates 0), the second is retried.
describe("Gong", () => {
  afterEach(() => vi.unstubAllGlobals());
  const conn = { accessToken: "key", refreshToken: "secret", config: {} } as unknown as IntegrationConnection;
  const cursor = "2026-10-07T12:00:00.000Z";

  it("reads an empty window as no calls and an untranscribed page as transient", async () => {
    respond(404);
    expect(await gong.count!(conn, new Date(cursor))).toBe(0);
    expect(await gong.listSince(conn, cursor)).toEqual({ records: [], nextCursor: cursor, done: true });

    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).endsWith("/v2/calls/transcript")
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ calls: [{ id: "c1", started: "2026-10-07T12:30:00Z" }] }) }));
    await expect(gong.listSince(conn, cursor)).rejects.toMatchObject({ reason: "transient" });

    respond(401); // a refused key is still an auth failure
    await expect(gong.listSince(conn, cursor)).rejects.toMatchObject({ reason: "auth" });
  });

  it("holds the cursor before a recent call whose transcript isn't ready, but not an old one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T14:00:00Z"));
    try {
      const page = (calls: Array<{ id: string; started: string }>, transcribed: string[]) =>
        vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).endsWith("/v2/calls/transcript")
          ? { ok: true, status: 200, json: async () => ({ callTranscripts: transcribed.map((callId) => ({ callId, transcript: [{ sentences: [{ text: "We need SSO." }] }] })) }) }
          : { ok: true, status: 200, json: async () => ({ calls }) }));

      // c2 (an hour old) has no transcript yet: c3 is captured, but the cursor
      // stays just after c1 so the next run reads c2 again.
      page([{ id: "c3", started: "2026-10-07T13:30:00Z" }, { id: "c1", started: "2026-10-07T12:30:00Z" }, { id: "c2", started: "2026-10-07T13:00:00Z" }], ["c1", "c3"]);
      const held = await gong.listSince(conn, cursor);
      expect(held.records.map((r) => r.externalId)).toEqual(["c1", "c3"]);
      expect(held).toMatchObject({ nextCursor: "2026-10-07T12:30:01.000Z", done: true });

      // The same gap two days later was never recorded: it no longer holds the cursor.
      vi.setSystemTime(new Date("2026-10-09T14:00:00Z"));
      const moved = await gong.listSince(conn, cursor);
      expect(moved.nextCursor).toBe("2026-10-07T13:30:01.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
