import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, workspaces } from "@crumb/db";
import { POST as jiraWebhook } from "@/app/api/integrations/jira/webhook/route";
import { GET as jiraCallback } from "@/app/api/integrations/jira/callback/route";
import { ensureWebhook, verifyWebhookToken, webhookUrl } from "@/lib/integrations/jira";
import { signState } from "@/lib/integrations/state";

// Jira status sync on Cloud. OAuth apps get no app-level webhook, so each
// install registers its own at a URL carrying an HMAC of its workspace id, and
// a delivery may only touch that workspace's items. The deployment-wide
// JIRA_WEBHOOK_SECRET stays for self-host's manual webhook: on Cloud every
// tenant would hold it and could sign an event naming another tenant's site.
//
// The route and callback cases run the real handlers against Postgres
// (DATABASE_URL); like tracker-webhook-scope.test.ts they skip locally when no
// database answers, and fail in CI.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSession }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const dbIt = it.skipIf(!reachable && !process.env.CI);

const APP = "https://crumb.example.test";
const tag = randomUUID().slice(0, 8);
const created: string[] = [];

// A workspace connected to `site` with one item linked to PROJ-7.
async function linkedWorkspace(site: string) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `jira-wh-${tag}-${created.length}`, name: "Jira webhook test", jiraSiteUrl: site })
    .returning({ id: workspaces.id });
  created.push(ws.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
  const [submitter] = await db.insert(accountUsers)
    .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id });
  const [item] = await db.insert(items).values({
    workspaceId: ws.id, accountId: acct.id, submitterId: submitter.id,
    seq: 1, shortId: "FB-1", title: "Linked item", type: "bug",
    externalProvider: "jira", externalTicketId: "PROJ-7", externalStatus: "untouched",
  }).returning({ id: items.id });
  return { id: ws.id, item: item.id };
}

async function statusOf(itemId: string) {
  const [row] = await db.select({ status: items.externalStatus }).from(items).where(eq(items.id, itemId));
  return row.status;
}

const doneOn = (site: string) => ({
  webhookEvent: "jira:issue_updated",
  issue: { key: "PROJ-7", self: `${site}/rest/api/2/issue/10002` },
  changelog: { items: [{ field: "status", toString: "Done" }] },
});

function deliver(query: string, payload: unknown, headers: (body: string) => Record<string, string> = () => ({})) {
  const body = JSON.stringify(payload);
  return jiraWebhook(new Request(`http://0.0.0.0:3000/api/integrations/jira/webhook${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(body) },
    body,
  }));
}

const tokenOf = (workspaceId: string) => new URL(webhookUrl(APP, workspaceId)!).searchParams.get("t");

describe("jira status webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    vi.stubEnv("CRUMB_APP_URL", APP);
    vi.stubEnv("CRUMB_OAUTH_STATE_SECRET", "test-state-secret");
    vi.stubEnv("JIRA_CLIENT_ID", "test-jira-client");
    vi.stubEnv("JIRA_CLIENT_SECRET", "test-jira-client-secret");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-jira-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("the URL token verifies for its own workspace only", () => {
    const a = randomUUID();
    const url = new URL(webhookUrl(APP, a)!);
    expect(`${url.origin}${url.pathname}`).toBe(`${APP}/api/integrations/jira/webhook`);
    expect(url.searchParams.get("ws")).toBe(a);
    const t = url.searchParams.get("t");
    expect(verifyWebhookToken(a, t)).toBe(true);
    expect(verifyWebhookToken(randomUUID(), t)).toBe(false);
    expect(verifyWebhookToken(a, `${t}x`)).toBe(false);
    expect(verifyWebhookToken(a, null)).toBe(false);
    vi.stubEnv("JIRA_CLIENT_SECRET", "rotated-secret");
    expect(verifyWebhookToken(a, t)).toBe(false);
    vi.stubEnv("JIRA_CLIENT_SECRET", "");
    expect(webhookUrl(APP, a)).toBeNull();
    expect(verifyWebhookToken(a, t)).toBe(false);
  });

  dbIt("a valid token for workspace A cannot update workspace B's items", async () => {
    // Same site, same key: only the token tells the two tenants apart.
    const site = `https://shared-${tag}.atlassian.net`;
    const a = await linkedWorkspace(site);
    const b = await linkedWorkspace(site);

    expect((await deliver(`?ws=${b.id}&t=${tokenOf(a.id)}`, doneOn(site))).status).toBe(400);
    expect(await statusOf(b.item)).toBe("untouched");

    expect((await deliver(`?ws=${a.id}&t=${tokenOf(a.id)}`, doneOn(site))).status).toBe(200);
    expect(await statusOf(a.item)).toBe("Done");
    expect(await statusOf(b.item)).toBe("untouched");
  });

  dbIt("the shared-secret webhook is refused on Cloud and scoped by site on self-host", async () => {
    const siteA = `https://a-${tag}.atlassian.net`;
    const a = await linkedWorkspace(siteA);
    const b = await linkedWorkspace(`https://b-${tag}.atlassian.net`);
    const signed = (body: string) => ({
      "x-hub-signature": `sha256=${createHmac("sha256", "test-jira-secret").update(body).digest("hex")}`,
    });

    expect((await deliver("", doneOn(siteA), signed)).status).toBe(400);
    expect(await statusOf(a.item)).toBe("untouched");

    vi.stubEnv("CRUMB_TIER", "self_host");
    expect((await deliver("", doneOn(siteA), signed)).status).toBe(200);
    expect(await statusOf(a.item)).toBe("Done");
    expect(await statusOf(b.item)).toBe("untouched");
  });

  it("ensureWebhook registers a status-only pair at the workspace URL, then only extends it", async () => {
    const ws = randomUUID();
    let hooks = [
      // Ours at a stale origin, and another workspace's on the same site.
      { id: 1, url: `https://old.example.test/api/integrations/jira/webhook?ws=${ws}&t=stale`, jqlFilter: 'project = "PROJ"' },
      { id: 2, url: `${APP}/api/integrations/jira/webhook?ws=${randomUUID()}&t=x`, jqlFilter: 'project = "PROJ"' },
    ];
    let project = "PROJ";
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname.replace(/^.*\/rest\/api\/3/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === "/project/search") return Response.json({ values: [{ id: "1", key: project, name: "Project" }] });
      if (method === "GET") return Response.json({ values: hooks });
      writes.push([method, path, body]);
      if (method === "DELETE") hooks = hooks.filter(h => !body.webhookIds.includes(h.id));
      if (method !== "POST") return Response.json({});
      // Stored normalized (unquoted), as Jira may hand it back.
      hooks.push(...body.webhooks.map((w: { jqlFilter: string }, i: number) => (
        { id: 10 + i, url: body.url, jqlFilter: w.jqlFilter.replaceAll('"', "") })));
      return Response.json({ webhookRegistrationResult: [{ createdWebhookId: 10 }, { createdWebhookId: 11 }] });
    }));
    const t = { accessToken: "tok", cloudId: "cloud-1" };
    const statusOnly = { events: ["jira:issue_updated"], fieldIdsFilter: ["status"] };

    expect(await ensureWebhook(ws, t, APP)).toEqual({ ok: true });
    expect(writes).toEqual([
      ["DELETE", "/webhook", { webhookIds: [1] }],
      ["POST", "/webhook", {
        url: webhookUrl(APP, ws),
        webhooks: [{ ...statusOnly, jqlFilter: 'project = "PROJ"' }, { ...statusOnly, jqlFilter: 'project != "PROJ"' }],
      }],
    ]);

    writes.length = 0;
    expect(await ensureWebhook(ws, t, APP)).toEqual({ ok: true });
    expect(writes).toEqual([["PUT", "/webhook/refresh", { webhookIds: [10, 11] }]]);

    // The anchor project is gone: re-anchor rather than keep extending dead filters.
    project = "NEW";
    writes.length = 0;
    expect(await ensureWebhook(ws, t, APP)).toEqual({ ok: true });
    expect(writes).toEqual([
      ["DELETE", "/webhook", { webhookIds: [10, 11] }],
      ["POST", "/webhook", {
        url: webhookUrl(APP, ws),
        webhooks: [{ ...statusOnly, jqlFilter: 'project = "NEW"' }, { ...statusOnly, jqlFilter: 'project != "NEW"' }],
      }],
    ]);
  });

  dbIt("connecting keeps the install when the webhook can't be registered, and says so", async () => {
    const site = `https://c-${tag}.atlassian.net`;
    const ws = await linkedWorkspace(site);
    getSession.mockResolvedValue({ workspace: { id: ws.id }, user: { id: "user-1", role: "admin" } });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const { pathname } = new URL(input);
      if (pathname === "/oauth/token") {
        return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "", token_type: "Bearer" });
      }
      if (pathname === "/oauth/token/accessible-resources") {
        return Response.json([{ id: "cloud-c", url: site, name: "C", scopes: [] }]);
      }
      if (pathname.endsWith("/project/search")) return Response.json({ values: [{ id: "1", key: "PROJ", name: "Project" }] });
      return new Response("Unauthorized; scope does not match", { status: 401 }); // the webhook API
    }));

    const res = await jiraCallback(new Request(
      `http://0.0.0.0:3000/api/integrations/jira/callback?code=c&state=${signState("jira", ws.id)}`,
    ));
    expect(res.headers.get("location")).toBe(`${APP}/settings/integrations?jira=connected_no_sync`);
    const [row] = await db
      .select({ cloudId: workspaces.jiraCloudId, token: workspaces.jiraAccessToken })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id));
    expect(row.cloudId).toBe("cloud-c");
    expect(row.token).not.toBeNull();
  });
});
