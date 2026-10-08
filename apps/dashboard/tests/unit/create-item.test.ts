import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, itemEmbeddings, items, replies, workspaces, workspaceUsers } from "@crumb/db";
import { sign } from "@/lib/jwt";
import { GET as widgetGet, POST as widgetPost } from "@/app/api/v1/items/route";
import { composeItem } from "@/lib/compose";
import { autoNotifiesSubmitter, MCP_SOURCE, SLACK_SOURCE } from "@/lib/feedback/source";

// Every source goes through one create core (lib/items/create.ts): the widget
// now announces its submissions too (item.created, Teams, new-submission alert),
// and a Slack-style compose that passes no workspace still gets AI clustering
// and an embedding when the plan has AI. An Autopilot duplicate (announce and
// triage off) gets none of it. The widget's list reads whose turn it is with
// the inbox's rule (lastTurnSideSql).
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

const h = vi.hoisted(() => ({ events: [] as string[], embedded: [] as string[] }));
vi.mock("@/lib/webhooks", () => ({
  emitEvent: async (_ws: string, e: { type: string; account: string }) => { h.events.push(`${e.type}:${e.account}`); },
}));
vi.mock("@/lib/notify/chat", () => ({
  notifyWorkspaceChannel: async (_ws: string, n: { kind: string }) => { h.events.push(n.kind); },
}));
vi.mock("@/lib/vendor-notify", () => ({
  notifyNewSubmission: async () => { h.events.push("alert"); },
}));
vi.mock("@/lib/ai/cluster", () => ({ clusterConfigured: () => true }));
vi.mock("@/lib/ai/auto-cluster", () => ({
  autoClusterItem: async () => { h.events.push("cluster"); },
}));
vi.mock("@/lib/ai/triage", () => ({ triageConfigured: () => false, suggestTriage: async () => null, TRIAGE_MODEL: "test" }));
vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDINGS_MODEL: "test-embed",
  EMBEDDINGS_DIM: 1024,
  embeddingsConfigured: () => true,
  embedText: async (text: string) => {
    h.embedded.push(text);
    return Array.from({ length: 1024 }, (_, i) => (i === h.embedded.length ? 1 : 0));
  },
}));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("createItem: one create path for every source", () => {
  let ws: { id: string; slug: string; secret: string } | null = null;
  const embeddingOf = async (itemId: string) =>
    (await db.select({ id: itemEmbeddings.itemId }).from(itemEmbeddings).where(eq(itemEmbeddings.itemId, itemId))).length;

  beforeAll(async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    [ws] = await db.insert(workspaces)
      .values({ slug: `create-${randomUUID().slice(0, 8)}`, name: "Create test", planId: "team", subscriptionStatus: "active" })
      .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!ws) return;
    await db.delete(items).where(eq(items.workspaceId, ws.id));
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  });

  it("announces and enriches a widget submission, naming the customer's real account", async () => {
    const jwt = sign({ iss: ws!.slug, sub: "pat@globex.test", account_name: "Globex", exp: Math.floor(Date.now() / 1000) + 300 }, ws!.secret);
    const res = await widgetPost(new Request("http://localhost/api/v1/items", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ type: "bug", title: "Export is empty", body: "Headers only." }),
    }));
    expect(res.status).toBe(201);
    const { id, short_id } = await res.json();

    expect(h.events).toEqual(["item.created:Globex", "new_submission", "alert", "cluster"]);
    await vi.waitFor(async () => expect(await embeddingOf(id)).toBe(1), { timeout: 5_000 });
    const [row] = await db.select({ source: items.source }).from(items).where(eq(items.id, id));
    expect(row.source).toBe("widget");

    // The widget's list reads whose turn it is with the inbox's rule.
    const mine = async () => {
      const list = await widgetGet(new Request("http://localhost/api/v1/items", { headers: { authorization: `Bearer ${jwt}` } }));
      return (await list.json()).items.find((i: { short_id: string }) => i.short_id === short_id);
    };
    expect(await mine()).toMatchObject({ last_reply_side: "customer", turn: "yours" });
    const [sam] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws!.id, email: "sam@vendor.test", name: "Sam", initials: "S" })
      .returning({ id: workspaceUsers.id });
    await db.insert(replies).values({ itemId: id, workspaceUserId: sam.id, body: "On it", internal: false, createdAt: new Date(Date.now() + 1_000) });
    expect(await mine()).toMatchObject({ last_reply_side: "vendor", turn: "waiting" });
  });

  it("enriches a compose that passes no workspace, and keeps an Autopilot duplicate quiet", async () => {
    h.events.length = 0;
    const base = { workspaceId: ws!.id, accountName: "Globex", submitterEmail: "lee@globex.test", type: "idea" };

    const dup = await composeItem({ ...base, title: "Folded duplicate", announce: false, triage: false });
    if (!dup.ok) throw new Error(dup.error);
    expect(h.events).toEqual([]);

    const slack = await composeItem({ ...base, title: "From Slack", source: SLACK_SOURCE });
    if (!slack.ok) throw new Error(slack.error);
    expect(h.events).toEqual(["item.created:Globex", "new_submission", "alert", "cluster"]);
    await vi.waitFor(async () => expect(await embeddingOf(slack.itemId)).toBe(1), { timeout: 5_000 });

    // The duplicate started first, so had it been triaged it would be done by now.
    expect(h.embedded.some(t => t.startsWith("Folded duplicate"))).toBe(false);
    expect(await embeddingOf(dup.itemId)).toBe(0);
    const [row] = await db.select({ source: items.source }).from(items).where(eq(items.id, slack.itemId));
    expect(row.source).toBe("slack");
  });

  it("never auto-emails the customer of a Slack /crumb or MCP item", () => {
    expect(autoNotifiesSubmitter(SLACK_SOURCE)).toBe(false);
    expect(autoNotifiesSubmitter(MCP_SOURCE)).toBe(false);
  });
});
