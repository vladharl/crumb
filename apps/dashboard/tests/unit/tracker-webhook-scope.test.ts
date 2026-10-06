import { afterAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, workspaces } from "@crumb/db";
import { POST as linearWebhook } from "@/app/api/integrations/linear/webhook/route";
import { POST as jiraWebhook } from "@/app/api/integrations/jira/webhook/route";
import { POST as githubWebhook } from "@/app/api/integrations/github/webhook/route";

// Tenant isolation for the issue-tracker status webhooks. The signing secrets
// are deployment-wide and ticket ids repeat across tenants (ENG-42 in every
// Linear org, PROJ-7 on every Jira site, #12 in every repo), so an event from
// one workspace's integration must never touch another workspace's item.
//
// Runs the real route handlers against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`). Skipped locally when no database answers; CI has one,
// so there it fails instead of skipping.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

process.env.LINEAR_WEBHOOK_SECRET = "test-linear-secret";
process.env.JIRA_WEBHOOK_SECRET = "test-jira-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-github-secret";

const tag = randomUUID().slice(0, 8);
const created: string[] = [];

// A workspace (with whatever integration columns the case needs) plus a
// function that links a new item in it to an external ticket.
async function workspace(cols: Partial<typeof workspaces.$inferInsert>) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `wh-scope-${tag}-${created.length}`, name: "Webhook scope test", ...cols })
    .returning({ id: workspaces.id });
  created.push(ws.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
  const [submitter] = await db.insert(accountUsers)
    .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id });
  let seq = 0;
  return async (provider: string, externalTicketId: string, externalTicketUrl: string | null = null) => {
    seq++;
    const [item] = await db.insert(items).values({
      workspaceId: ws.id, accountId: acct.id, submitterId: submitter.id,
      seq, shortId: `FB-${seq}`, title: "Linked item", type: "bug",
      externalProvider: provider, externalTicketId, externalTicketUrl, externalStatus: "untouched",
    }).returning({ id: items.id });
    return item.id;
  };
}

async function statusOf(itemId: string) {
  const [row] = await db.select({ status: items.externalStatus }).from(items).where(eq(items.id, itemId));
  return row.status;
}

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

function deliver(handler: (req: Request) => Promise<Response>, payload: unknown, headers: (body: string) => Record<string, string>) {
  const body = JSON.stringify(payload);
  return handler(new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(body) },
    body,
  }));
}

describe.skipIf(!reachable && !process.env.CI)("tracker webhooks only update the sending integration's workspace", () => {
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("linear: scoped by organizationId; installs without one resolve it from their token", async () => {
    const orgA = `org-a-${tag}`;
    const legacyToken = `tok-legacy-${tag}`;
    // The only Linear call expected: the legacy install asking which org it is in.
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (new Headers(init?.headers).get("authorization") === `Bearer ${legacyToken}`) {
        return Response.json({ data: { organization: { id: orgA } } });
      }
      throw new Error("unexpected fetch");
    }));

    const linkA = await workspace({ linearAccessToken: `tok-a-${tag}`, linearOrganizationId: orgA });
    const linkB = await workspace({ linearAccessToken: `tok-b-${tag}`, linearOrganizationId: `org-b-${tag}` });
    const linkLegacy = await workspace({ linearAccessToken: legacyToken });
    const a = await linkA("linear", "ENG-42");
    const b = await linkB("linear", "ENG-42");
    const legacy = await linkLegacy("linear", "ENG-42");

    const res = await deliver(linearWebhook, {
      action: "update",
      type: "Issue",
      organizationId: orgA,
      data: { id: randomUUID(), identifier: "ENG-42", state: { name: "Done" } },
    }, body => ({ "linear-signature": hmac("test-linear-secret", body) }));

    expect(res.status).toBe(200);
    expect(await statusOf(a)).toBe("Done");
    expect(await statusOf(legacy)).toBe("Done");
    expect(await statusOf(b)).toBe("untouched");
  });

  it("jira: scoped by the site in issue.self", async () => {
    const linkA = await workspace({ jiraSiteUrl: `https://a-${tag}.atlassian.net` });
    const linkB = await workspace({ jiraSiteUrl: `https://b-${tag}.atlassian.net` });
    const a = await linkA("jira", "PROJ-7");
    const b = await linkB("jira", "PROJ-7");

    const res = await deliver(jiraWebhook, {
      webhookEvent: "jira:issue_updated",
      issue: { key: "PROJ-7", self: `https://a-${tag}.atlassian.net/rest/api/2/issue/10002` },
      changelog: { items: [{ field: "status", toString: "Done" }] },
    }, body => ({ "x-hub-signature": `sha256=${hmac("test-jira-secret", body)}` }));

    expect(res.status).toBe(200);
    expect(await statusOf(a)).toBe("Done");
    expect(await statusOf(b)).toBe("untouched");
  });

  it("github: scoped by installation, matched on owner/repo#N (bare #N rows by their issue URL)", async () => {
    const installA = randomInt(1e9, 2e9);
    const url = "https://github.com/acme/app/issues/12";
    const linkA = await workspace({ githubAppInstallId: String(installA) });
    const linkB = await workspace({ githubAppInstallId: String(installA + 1) });
    const a = await linkA("github", "acme/app#12", url);
    const aLegacy = await linkA("github", "#12", url);
    const aOtherRepo = await linkA("github", "#12", "https://github.com/acme/other/issues/12");
    // Same strings in another tenant: only the installation tells them apart.
    const b = await linkB("github", "acme/app#12", url);
    const bLegacy = await linkB("github", "#12", url);

    const res = await deliver(githubWebhook, {
      action: "closed",
      issue: { number: 12, html_url: url, state: "closed" },
      repository: { full_name: "acme/app" },
      installation: { id: installA },
    }, body => ({ "x-github-event": "issues", "x-hub-signature-256": `sha256=${hmac("test-github-secret", body)}` }));

    expect(res.status).toBe(200);
    expect(await statusOf(a)).toBe("closed");
    expect(await statusOf(aLegacy)).toBe("closed");
    expect(await statusOf(aOtherRepo)).toBe("untouched");
    expect(await statusOf(b)).toBe("untouched");
    expect(await statusOf(bLegacy)).toBe("untouched");
  });
});
