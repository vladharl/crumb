import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, workspaces } from "@crumb/db";
import { POST as linearWebhook } from "@/app/api/integrations/linear/webhook/route";
import { POST as jiraWebhook } from "@/app/api/integrations/jira/webhook/route";
import { GET as jiraCallback } from "@/app/api/integrations/jira/callback/route";
import { POST as githubWebhook } from "@/app/api/integrations/github/webhook/route";
import { webhookUrl } from "@/lib/integrations/jira";
import { signState } from "@/lib/integrations/state";
import { setJiraSite } from "@/app/(app)/settings/integrations/actions";

// Linked tickets keep syncing after they move. The tracker webhooks match an
// item on the ticket's stable id (external_ticket_uid) and write back its
// current key and URL: ENG-42 moved to another Linear team, PROJ-7 moved to
// another Jira project, an issue in a renamed or transferred GitHub repo. Rows
// linked before the id was stored match on their key once and get it then.
// Also the Jira site a login with several sites gets to pick.
//
// Runs the real handlers against Postgres (DATABASE_URL); skipped locally when
// no database answers, like tracker-webhook-scope.test.ts.

const h = vi.hoisted(() => ({ getSession: vi.fn(), session: null as unknown }));
vi.mock("@/lib/auth", () => ({ getSession: h.getSession }));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const APP = "https://crumb.example.test";
const tag = randomUUID().slice(0, 8);
const created: string[] = [];

// A workspace plus a function that links a new item in it to a ticket.
async function workspace(cols: Partial<typeof workspaces.$inferInsert>) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `uid-${tag}-${created.length}`, name: "Ticket uid test", ...cols })
    .returning();
  created.push(ws.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
  const [submitter] = await db.insert(accountUsers)
    .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id });
  let seq = 0;
  const link = async (provider: string, key: string, uid: string | null, url: string | null = null) => {
    seq++;
    const [item] = await db.insert(items).values({
      workspaceId: ws.id, accountId: acct.id, submitterId: submitter.id,
      seq, shortId: `FB-${seq}`, title: "Linked item", type: "bug",
      externalProvider: provider, externalTicketId: key, externalTicketUid: uid, externalTicketUrl: url,
      externalStatus: "untouched",
    }).returning({ id: items.id });
    return item.id;
  };
  return { ws, link };
}

async function ticketOf(itemId: string) {
  const [row] = await db
    .select({ status: items.externalStatus, key: items.externalTicketId, uid: items.externalTicketUid, url: items.externalTicketUrl })
    .from(items)
    .where(eq(items.id, itemId));
  return row;
}

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

function post(handler: (req: Request) => Promise<Response>, url: string, payload: unknown, headers: (body: string) => Record<string, string>) {
  const body = JSON.stringify(payload);
  return handler(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers(body) }, body }));
}

describe.skipIf(!reachable && !process.env.CI)("tracker webhooks follow a ticket by its stable id", () => {
  beforeEach(() => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    vi.stubEnv("CRUMB_APP_URL", APP);
    vi.stubEnv("CRUMB_OAUTH_STATE_SECRET", "test-state-secret");
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", "test-linear-secret");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-github-secret");
    vi.stubEnv("JIRA_CLIENT_ID", "test-jira-client");
    vi.stubEnv("JIRA_CLIENT_SECRET", "test-jira-client-secret");
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

  it("linear: a moved issue keeps its link, a legacy row gets its id, a reused key matches nothing else", async () => {
    const org = `org-${tag}`;
    const { link } = await workspace({ linearAccessToken: `tok-${tag}`, linearOrganizationId: org });
    const issueUrl = (key: string) => `https://linear.app/acme-${tag}/issue/${key}/csv-export`;
    const moved = await link("linear", "ENG-1", `lin-moved-${tag}`, issueUrl("ENG-1"));
    const legacy = await link("linear", "ENG-2", null, issueUrl("ENG-2"));
    const sameKey = await link("linear", "ENG-2", `lin-other-${tag}`, issueUrl("ENG-2"));
    const deliver = (id: string, identifier: string) => post(linearWebhook, "http://localhost/webhook", {
      action: "update", type: "Issue", organizationId: org,
      data: { id, identifier, url: issueUrl(identifier), state: { name: "Done" } },
    }, body => ({ "linear-signature": hmac("test-linear-secret", body) }));

    expect((await deliver(`lin-moved-${tag}`, "DES-7")).status).toBe(200);
    expect(await ticketOf(moved)).toEqual({ status: "Done", key: "DES-7", uid: `lin-moved-${tag}`, url: issueUrl("DES-7") });

    expect((await deliver(`lin-legacy-${tag}`, "ENG-2")).status).toBe(200);
    expect(await ticketOf(legacy)).toMatchObject({ status: "Done", key: "ENG-2", uid: `lin-legacy-${tag}` });
    expect(await ticketOf(sameKey)).toMatchObject({ status: "untouched", uid: `lin-other-${tag}` });
  });

  it("jira: a moved issue takes its new key and browse URL", async () => {
    const site = `https://acme-${tag}.atlassian.net`;
    const { ws, link } = await workspace({ jiraSiteUrl: site });
    const item = await link("jira", "PROJ-7", "10002", `${site}/browse/PROJ-7`);
    const token = new URL(webhookUrl(APP, ws.id)!).searchParams.get("t");

    const res = await post(jiraWebhook, `http://0.0.0.0:3000/api/integrations/jira/webhook?ws=${ws.id}&t=${token}`, {
      webhookEvent: "jira:issue_updated",
      issue: { id: "10002", key: "NEW-3", self: `${site}/rest/api/2/issue/10002` },
      changelog: { items: [{ field: "status", toString: "In Progress" }] },
    }, () => ({}));

    expect(res.status).toBe(200);
    expect(await ticketOf(item)).toEqual({ status: "In Progress", key: "NEW-3", uid: "10002", url: `${site}/browse/NEW-3` });
  });

  it("github: follows a repo rename and an issue transfer, and keeps a non-https URL out", async () => {
    const installation = { id: randomInt(1e9, 2e9) };
    const { link } = await workspace({ githubAppInstallId: String(installation.id) });
    const item = await link("github", "acme/app#12", `I_one_${tag}`, "https://github.com/acme/app/issues/12");
    const deliver = (payload: object) => post(githubWebhook, "http://localhost/webhook", { installation, ...payload },
      body => ({ "x-github-event": "issues", "x-hub-signature-256": `sha256=${hmac("test-github-secret", body)}` }));
    const issue12 = { number: 12, node_id: `I_one_${tag}`, html_url: "https://github.com/acme/renamed/issues/12", state: "closed" };

    expect((await deliver({ action: "closed", issue: issue12, repository: { full_name: "acme/renamed" } })).status).toBe(200);
    expect(await ticketOf(item)).toEqual({ status: "closed", key: "acme/renamed#12", uid: `I_one_${tag}`, url: issue12.html_url });

    await deliver({ action: "edited", issue: { ...issue12, html_url: "javascript:alert(1)" }, repository: { full_name: "acme/renamed" } });
    expect((await ticketOf(item)).url).toBe(issue12.html_url);

    await deliver({
      action: "transferred",
      issue: issue12,
      repository: { full_name: "acme/renamed" },
      changes: {
        new_issue: { number: 3, node_id: `I_two_${tag}`, html_url: "https://github.com/acme/other/issues/3", state: "open" },
        new_repository: { full_name: "acme/other" },
      },
    });
    expect(await ticketOf(item)).toEqual({
      status: "open", key: "acme/other#3", uid: `I_two_${tag}`, url: "https://github.com/acme/other/issues/3",
    });
  });

  it("jira: a login that reaches several sites waits for the admin's pick, which a reconnect keeps", async () => {
    const { ws } = await workspace({ planId: "team", subscriptionStatus: "active" });
    const admin = { workspace: { id: ws.id }, user: { id: "user-1", role: "admin" } };
    h.getSession.mockResolvedValue(admin);
    const sites = [
      { id: `cloud-a-${tag}`, url: `https://a-${tag}.atlassian.net`, name: "A", scopes: [] },
      { id: `cloud-b-${tag}`, url: `https://b-${tag}.atlassian.net`, name: "B", scopes: [] },
    ];
    let projects = [{ id: "1", key: "PROJ", name: "Project" }];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const { pathname } = new URL(input);
      if (pathname === "/oauth/token") {
        return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "", token_type: "Bearer" });
      }
      if (pathname === "/oauth/token/accessible-resources") return Response.json(sites);
      if (pathname.endsWith("/project/search")) return Response.json({ values: projects, isLast: true });
      if (pathname.endsWith("/webhook") && !input.includes("refresh")) return Response.json({ values: [], webhookRegistrationResult: [{}] });
      return new Response("not found", { status: 404 });
    }));

    const connect = () => jiraCallback(new Request(
      `http://0.0.0.0:3000/api/integrations/jira/callback?code=c&state=${signState("jira", ws.id)}`,
    ));
    expect((await connect()).headers.get("location")).toBe(`${APP}/settings/integrations?jira=pick_site`);
    let [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row).toMatchObject({ jiraCloudId: null, jiraSiteUrl: null, jiraInstalledAt: null });
    expect(row.jiraAccessToken).not.toBeNull();

    h.session = { workspace: row, user: { id: "user-1", role: "admin" } };
    expect(await setJiraSite("cloud-of-someone-else")).toEqual({ ok: false, error: "site_not_found" });
    expect(await setJiraSite(sites[1].id)).toEqual({ ok: true });
    [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row).toMatchObject({ jiraCloudId: sites[1].id, jiraSiteUrl: sites[1].url, jiraDefaultProjectKey: "PROJ" });
    expect(row.jiraInstalledAt).not.toBeNull();

    // Reconnecting (how status sync gets another try) keeps the picked site
    // and its default project, though the site now has several.
    projects = [...projects, { id: "2", key: "OTHER", name: "Other" }];
    expect((await connect()).headers.get("location")).toBe(`${APP}/settings/integrations?jira=connected`);
    [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row).toMatchObject({ jiraCloudId: sites[1].id, jiraDefaultProjectKey: "PROJ" });
  });
});
