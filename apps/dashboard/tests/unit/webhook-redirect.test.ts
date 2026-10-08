import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { deliverEvent } from "@/lib/webhooks";
import { postSlackWebhook } from "@/lib/notify/chat";
import { fetchSitePreview } from "@/app/(app)/settings/branding/actions";

// Outbound webhooks must never follow a redirect. isDeliverableUrl vets the
// registered URL only, so a public receiver answering 302 could otherwise
// bounce the signed POST to 169.254.169.254 or an internal host. A real local
// receiver 302s /hook → /internal: delivery has to stop at the 302 and count it
// as a failure. The DB is faked (one endpoint in, the status update out).
// The chat webhooks (vendor Teams, customer Slack/Teams) are the same: their
// allowlist admits *.logic.azure.com, where a Logic App can answer any 3xx.
// The branding site preview does follow redirects, by hand, vetting each hop.

const h = vi.hoisted(() => ({
  endpoint: {} as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ user: { role: "admin" } }) }));
// "dashboard" is a Docker-network name; everything else resolves public.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: host === "dashboard" ? "172.18.0.3" : "93.184.216.34", family: 4 }],
}));

vi.mock("@crumb/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crumb/db")>()),
  db: {
    select: () => ({ from: () => ({ where: async () => [h.endpoint] }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        h.updates.push(v);
        return { where: async () => undefined };
      },
    }),
    // The delivery log's write and prune.
    insert: () => ({ values: async () => undefined }),
    execute: async () => [],
  },
}));

const hits: string[] = [];
let server: Server;

beforeAll(async () => {
  vi.stubEnv("CRUMB_TIER", "self_host"); // Cloud would refuse 127.0.0.1 before fetching
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/hook") res.writeHead(302, { location: "/internal" }).end();
    else res.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

afterAll(() => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  server.close();
});

describe("outbound webhook delivery", () => {
  it("does not follow a 3xx and records it as a failed delivery", async () => {
    const { port } = server.address() as AddressInfo;
    h.endpoint = {
      id: "ep-1", workspaceId: "ws-1", url: `http://127.0.0.1:${port}/hook`, secret: "s3cret",
      events: ["item.status_changed"], active: true, lastStatus: null, lastAttemptAt: null, failureCount: 0,
    };

    await deliverEvent("ws-1", {
      type: "item.status_changed", workspace: "acme", at: new Date().toISOString(),
      item: { short_id: "FB-1", title: "Export breaks", type: "bug" },
      from_status: "open", to_status: "planned", reason: null,
    });

    expect(hits).toEqual(["POST /hook"]); // the redirect target was never requested
    expect(h.updates).toEqual([expect.objectContaining({ lastStatus: 302 })]);
    // A failed event: the streak goes up by one (counted in SQL).
    expect(new PgDialect().sqlToQuery(h.updates[0]!.failureCount as SQL).sql).toBe('"webhook_endpoints"."failure_count" + 1');
  });

  it("chat webhooks don't follow a 3xx either", async () => {
    vi.stubEnv("CRUMB_WEBHOOK_ALLOW_ANY", "1"); // the host allowlist would refuse 127.0.0.1
    hits.length = 0;
    const { port } = server.address() as AddressInfo;

    expect(await postSlackWebhook(`http://127.0.0.1:${port}/hook`, { text: "FB-1 → planned" }))
      .toEqual({ ok: false, error: "http_302" });
    expect(hits).toEqual(["POST /hook"]);
  });
});

describe("branding site preview", () => {
  it("re-checks each redirect hop, so a public page can't bounce the fetch to an internal host", async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    const fetched = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(null, { status: 302, headers: { location: "http://dashboard:3000/settings" } }));
    vi.stubGlobal("fetch", fetched);

    expect(await fetchSitePreview("https://site.test/")).toEqual({ ok: false, error: "That host can't be previewed." });
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    vi.unstubAllGlobals();
  });
});
