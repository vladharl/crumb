import { test, expect, type Page } from "@playwright/test";
import { mintWidgetJwt, psql, publicOrigin } from "./helpers/mint";

// The Install page builds every snippet from this deployment's public origin
// (CRUMB_APP_URL), so what people copy works as pasted, and it watches for the
// widget's first real load: GET /api/v1/me stamps workspaces.widget_first_ping_at
// unless the caller is the Try-it preview's test customer
// (app/(app)/settings/install). Pings here are minted widget JWTs, the same
// tokens a vendor's server signs.

const SLUG = "southbeam";
const TEST_CUSTOMER_ACCOUNT = "Test customer (you)"; // settings/install/test-customer.ts

const installed = () => psql(`SELECT widget_first_ping_at IS NOT NULL FROM workspaces WHERE slug = '${SLUG}'`);

test.afterAll(() => {
  // The seed marks southbeam installed; leave it so for later specs, even if
  // this one failed midway. The preview ping's test account goes too.
  psql(
    `UPDATE workspaces SET widget_first_ping_at = coalesce(widget_first_ping_at, now()) WHERE slug = '${SLUG}';
     DELETE FROM accounts WHERE name = '${TEST_CUSTOMER_ACCOUNT}'
       AND workspace_id = (SELECT id FROM workspaces WHERE slug = '${SLUG}')`,
  );
});

// Every code block on the page has its own Copy button, and any widget.js it
// loads comes from this deployment.
async function expectSnippets(page: Page, widgetSrc: string) {
  for (const block of await page.locator(".code").all()) {
    await expect(block.locator("xpath=..").getByRole("button", { name: /^Copy / })).toBeVisible();
    const code = await block.innerText();
    if (code.includes("widget.js")) expect(code).toContain(widgetSrc);
  }
}

test("snippets load this deployment's widget.js, each with a Copy button", async ({ page, baseURL }) => {
  const widgetSrc = `${publicOrigin(new URL(baseURL!).origin)}/widget.js`;

  await page.goto("/settings/install");
  await expect(page.locator(".code", { hasText: "in your page template" })).toContainText(`<script src="${widgetSrc}"`);
  // The whole document, so the signing examples behind the other tabs count too.
  expect(await page.content()).not.toContain("your-crumb-host");
  await expectSnippets(page, widgetSrc);

  // The signing examples show one language at a time.
  for (const tab of await page.getByRole("tablist", { name: "Server language" }).getByRole("tab").all()) {
    await tab.click();
    await expect(page.getByRole("button", { name: `Copy ${await tab.innerText()} example` })).toBeVisible();
    await expectSnippets(page, widgetSrc);
  }
});

test("the status turns connected on a real widget's first ping, never the test customer's", async ({ page, request }) => {
  psql(`UPDATE workspaces SET widget_first_ping_at = NULL WHERE slug = '${SLUG}'`);
  await page.goto("/settings/install");
  await expect(page.getByText("Waiting for your widget's first ping")).toBeVisible();

  const ping = async (sub: string, accountName: string) => {
    const jwt = mintWidgetJwt(SLUG, { sub, account_name: accountName });
    const res = await request.get("/api/v1/me", { headers: { authorization: `Bearer ${jwt}` } });
    expect(res.status()).toBe(200);
    expect((await res.json()).account.name).toBe(accountName);
  };

  // The Try-it preview's identity (actions.ts mintTestToken) is answered, but
  // isn't an install.
  await ping(`preview+e2e-${Date.now()}@${SLUG}.invalid`, TEST_CUSTOMER_ACCOUNT);
  expect(installed()).toBe("f");

  // A seeded customer's widget loads.
  const [email, accountName] = psql(
    `SELECT au.email, a.name FROM account_users au JOIN accounts a ON a.id = au.account_id
     WHERE a.workspace_id = (SELECT id FROM workspaces WHERE slug = '${SLUG}') AND a.name <> '${TEST_CUSTOMER_ACCOUNT}'
     ORDER BY au.created_at LIMIT 1`,
  ).split("|") as [string, string];
  await ping(email, accountName);
  expect(installed()).toBe("t");

  // The page polls every 5s while visible.
  await expect(page.getByText("Widget connected")).toBeVisible({ timeout: 15_000 });
});

// The widget boots /api/v1/me and /api/v1/items at once, and both create a
// brand-new customer on first contact: the Try-it preview's first load, or
// any new customer's. However they race, that's one account, one user, and
// every request answered.
test("a brand-new customer's first boot makes one account and one user, with no 500", async ({ request }) => {
  // A workspace's first Try it: no test customer yet.
  psql(`DELETE FROM accounts WHERE name = '${TEST_CUSTOMER_ACCOUNT}' AND workspace_id = (SELECT id FROM workspaces WHERE slug = '${SLUG}')`);
  const sub = `preview+boot-${Date.now()}@${SLUG}.invalid`;
  const headers = { authorization: `Bearer ${mintWidgetJwt(SLUG, { sub, name: "Lina Park", account_name: TEST_CUSTOMER_ACCOUNT })}` };

  // One boot's pair, and a reload's racing in behind it.
  const boots = await Promise.all(
    ["/api/v1/me", "/api/v1/items", "/api/v1/me", "/api/v1/items"].map((path) => request.get(path, { headers })),
  );
  expect(boots.map((r) => r.status())).toEqual([200, 200, 200, 200]);

  const counts = psql(
    `SELECT (SELECT count(*) FROM accounts WHERE workspace_id = w.id AND name = '${TEST_CUSTOMER_ACCOUNT}'),
            (SELECT count(*) FROM account_users WHERE workspace_id = w.id AND email = '${sub}'),
            (SELECT role FROM account_users WHERE workspace_id = w.id AND email = '${sub}')
     FROM workspaces w WHERE w.slug = '${SLUG}'`,
  );
  expect(counts).toBe("1|1|admin");
});
