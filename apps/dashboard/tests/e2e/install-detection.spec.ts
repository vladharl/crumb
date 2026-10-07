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
  // setup.ts marks southbeam installed; leave it so for later specs, even if
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
