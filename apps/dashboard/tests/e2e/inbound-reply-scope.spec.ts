import { test, expect, type APIRequestContext } from "@playwright/test";
import { mintWidgetJwt, psql, signReplyAddress } from "./helpers/mint";

// FB numbers are only unique per workspace, so a reply address's short id can
// name items in several tenants; the address's signature picks the one
// (lib/reply-token.ts pickReplyTarget). A second workspace gets an item with
// the same short id as a southbeam item, submitted by the same person under the
// same email: the shape a Cloud collision takes, and the one where a misrouted
// reply would still be accepted, on the wrong tenant's item. Its item is the
// most recently updated, so a route that took the first candidate would pick it.

test.use({ storageState: { cookies: [], origins: [] } }); // mail provider + widget side

const INBOUND_SECRET = "e2e-inbound"; // CRUMB_INBOUND_SECRET in playwright.config.ts
const OTHER_ACCOUNT = "E2E Collision Co";

const other = `e2e-collide-${Date.now()}`;
let shortId: string;
let email: string;
let accountName: string;

test.beforeAll(() => {
  let seq: string;
  [shortId, seq, email, accountName] = psql(
    `SELECT i.short_id, i.seq, au.email, a.name FROM items i
     JOIN account_users au ON au.id = i.submitter_id
     JOIN accounts a ON a.id = i.account_id
     JOIN workspaces w ON w.id = i.workspace_id
     WHERE w.slug = 'southbeam' ORDER BY i.seq LIMIT 1`,
  ).split("|") as [string, string, string, string];

  // signing_secret defaults to fresh random bytes.
  psql(
    `WITH w AS (INSERT INTO workspaces (slug, name) VALUES ('${other}', 'E2E Collision') RETURNING id),
     a AS (INSERT INTO accounts (workspace_id, name) SELECT id, '${OTHER_ACCOUNT}' FROM w RETURNING id, workspace_id),
     u AS (INSERT INTO account_users (workspace_id, account_id, email, name, initials)
           SELECT workspace_id, id, '${email}', 'Same Person', 'SP' FROM a RETURNING id, account_id, workspace_id)
     INSERT INTO items (workspace_id, account_id, submitter_id, seq, short_id, title, type)
     SELECT workspace_id, account_id, id, ${seq}, '${shortId}', 'Colliding item', 'bug' FROM u`,
  );
});

test.afterAll(() => {
  // items.submitter_id is ON DELETE RESTRICT, so the items go before the
  // workspace cascade takes the account users. Southbeam's test replies too.
  psql(
    `DELETE FROM items WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = '${other}');
     DELETE FROM workspaces WHERE slug = '${other}';
     DELETE FROM replies WHERE body LIKE 'e2e collision reply %'`,
  );
});

async function emailReply(request: APIRequestContext, to: string, text: string) {
  const res = await request.post("/api/v1/inbound/reply", {
    headers: { authorization: `Bearer ${INBOUND_SECRET}` },
    data: { to, from: `Same Person <${email}>`, subject: `Re: ${shortId}`, text },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

// The thread as the submitter sees it in that workspace's widget.
async function threadBodies(request: APIRequestContext, slug: string, account: string): Promise<string[]> {
  const res = await request.get(`/api/v1/items/${shortId}`, {
    headers: { authorization: `Bearer ${mintWidgetJwt(slug, { sub: email, account_name: account })}` },
  });
  expect(res.status()).toBe(200);
  return ((await res.json()).messages as Array<{ body: string }>).map((m) => m.body);
}

test("a reply to southbeam's address lands on southbeam's item only", async ({ request }) => {
  const text = `e2e collision reply ${Date.now()} for southbeam`;
  expect(await emailReply(request, signReplyAddress("southbeam", shortId), text)).toEqual({ ok: true, accepted: true, shortId });

  expect(await threadBodies(request, "southbeam", accountName)).toContain(text);
  expect(await threadBodies(request, other, OTHER_ACCOUNT)).not.toContain(text);
});

test("a reply signed by the other workspace never lands on southbeam's item", async ({ request }) => {
  const text = `e2e collision reply ${Date.now()} for the other tenant`;
  expect(await emailReply(request, signReplyAddress(other, shortId), text)).toEqual({ ok: true, accepted: true, shortId });

  expect(await threadBodies(request, "southbeam", accountName)).not.toContain(text);
  expect(await threadBodies(request, other, OTHER_ACCOUNT)).toContain(text);
});
