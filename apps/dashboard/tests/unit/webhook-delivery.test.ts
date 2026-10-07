import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { WebhookEndpoint } from "@crumb/db";
import { MAX_FAILURES, deliverEvent, sendTestEvent } from "@/lib/webhooks";

// Outbound webhook delivery: retries keep one event id and one signed body,
// every attempt is logged, a DNS failure is an ordinary failed attempt (it no
// longer pauses the endpoint at once), and "Send test" is a single attempt
// that leaves the failure streak alone. fetch, DNS and the DB are faked; the
// retry backoff runs on fake timers. A failed event bumps the streak and
// pauses at the limit in SQL, so concurrent deliveries can't lose a count.

const h = vi.hoisted(() => ({
  endpoint: {} as Record<string, unknown>,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  prunes: 0,
}));

// Cloud resolves the host before every attempt; this host never resolves.
vi.mock("node:dns/promises", () => ({
  lookup: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
}));

vi.mock("@crumb/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crumb/db")>()),
  db: {
    select: () => ({ from: () => ({ where: async () => [h.endpoint] }) }),
    insert: () => ({ values: async (v: Record<string, unknown>) => { h.inserts.push(v); } }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        h.updates.push(v);
        return { where: async () => undefined };
      },
    }),
    execute: async () => { h.prunes++; return []; }, // the delivery-log prune
  },
}));

const EVENT = {
  type: "item.status_changed", workspace: "acme", at: "2026-01-01T12:00:00.000Z",
  item: { short_id: "FB-1", title: "Export breaks", type: "bug" },
  from_status: "open", to_status: "planned", reason: null,
} as const;

type Sent = { headers: Headers; body: string };
// fetch answering with `statuses` in order, recording what was sent.
function receiver(statuses: number[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sent.push({ headers: new Headers(init.headers), body: String(init.body) });
    return new Response(null, { status: statuses.shift() });
  }));
  return sent;
}

const render = (v: unknown) => new PgDialect().sqlToQuery(v as SQL);
const FAILED = {
  failureCount: '"webhook_endpoints"."failure_count" + 1',
  active: '"webhook_endpoints"."failure_count" + 1 >= $1 THEN false ELSE "webhook_endpoints"."active"',
};
function expectFailedEvent(update: Record<string, unknown> | undefined) {
  expect(render(update?.failureCount).sql).toBe(FAILED.failureCount);
  const pause = render(update?.active);
  expect(pause.sql).toContain(FAILED.active);
  expect(pause.params).toEqual([MAX_FAILURES]);
}

async function deliver() {
  const done = deliverEvent("ws-1", EVENT);
  await vi.runAllTimersAsync(); // the retry backoff
  await done;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CRUMB_TIER", "self_host");
  h.inserts = [];
  h.updates = [];
  h.prunes = 0;
  h.endpoint = {
    id: "ep-1", workspaceId: "ws-1", url: "https://hooks.example.test/crumb", secret: "s3cret",
    events: ["item.status_changed"], active: true, lastStatus: null, lastAttemptAt: null, failureCount: 3,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("webhook delivery", () => {
  it("retries a 5xx with the same event id and body, logs each attempt, and clears the failure streak", async () => {
    const sent = receiver([503, 200]);
    await deliver();

    expect(sent).toHaveLength(2);
    const id = JSON.parse(sent[0]!.body).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    for (const s of sent) {
      expect(s.body).toBe(sent[0]!.body);
      expect(s.headers.get("x-crumb-event-id")).toBe(id);
      expect(s.headers.get("x-crumb-signature")).toBe("sha256=" + createHmac("sha256", "s3cret").update(s.body).digest("hex"));
    }
    expect(h.inserts).toEqual([
      expect.objectContaining({ endpointId: "ep-1", eventId: id, eventType: "item.status_changed", attempt: 1, httpStatus: 503, ok: false }),
      expect.objectContaining({ endpointId: "ep-1", eventId: id, attempt: 2, httpStatus: 200, ok: true, error: null }),
    ]);
    expect(h.updates).toEqual([expect.objectContaining({ lastStatus: 200, failureCount: 0 })]);
    expect(h.updates[0]).not.toHaveProperty("active"); // never re-activates a paused endpoint
  });

  it("does not retry a 4xx", async () => {
    const sent = receiver([400, 200]);
    await deliver();
    expect(sent).toHaveLength(1);
    expect(h.updates).toEqual([expect.objectContaining({ lastStatus: 400 })]);
    expectFailedEvent(h.updates[0]);
  });

  it("counts a failed DNS lookup toward the pause limit instead of pausing at once", async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    const sent = receiver([]);
    await deliver();

    expect(sent).toHaveLength(0);
    expect(h.inserts.map(r => [r.attempt, r.ok, r.httpStatus, r.error])).toEqual([
      [1, false, null, "blocked"], [2, false, null, "blocked"], [3, false, null, "blocked"],
    ]);
    expect(h.updates).toEqual([expect.objectContaining({ lastStatus: null })]);
    expectFailedEvent(h.updates[0]);
  });

  it("Send test: one signed, flagged sample of the first subscribed type; the streak is untouched", async () => {
    const sent = receiver([500]);
    h.endpoint.events = ["ticket.linked", "item.created"]; // catalog order picks item.created

    const r = await sendTestEvent(h.endpoint as WebhookEndpoint, "acme");

    expect(r).toEqual({ ok: false, status: 500, message: "Your server returned an error" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("x-crumb-test")).toBe("1");
    expect(sent[0]!.headers.get("x-crumb-event")).toBe("item.created");
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({ type: "item.created", workspace: "acme" });
    expect(sent[0]!.headers.get("x-crumb-event-id")).toBe(body.id);
    expect(h.inserts).toEqual([expect.objectContaining({ eventId: body.id, attempt: 1, httpStatus: 500, ok: false })]);
    expect(h.updates).toEqual([]);
    expect(h.prunes).toBe(1); // the test row counts toward the log cap
  });
});
