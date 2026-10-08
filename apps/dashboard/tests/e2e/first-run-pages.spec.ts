import { test, expect } from "@playwright/test";
import { mintMagicLink, psql } from "./helpers/mint";

// The pages a new user meets first: a dead link's not-found page inside the app,
// tab titles that name the page, and what a brand-new workspace shows before any
// feedback lands (components/SetupChecklist.tsx).

test("an unknown thread shows the in-app not-found page, with a way back", async ({ page }) => {
  await page.goto("/thread/FB-999999");
  await expect(page.getByRole("heading", { name: "We couldn't find that" })).toBeVisible();
  await expect(page.getByText("it points to another workspace")).toBeVisible(); // (app)/not-found, not the bare one
  await expect(page).toHaveTitle(/^Not found/);

  await page.getByRole("link", { name: "Back to inbox" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("tab titles name the page", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page).toHaveTitle(/Inbox/);

  const shortId = psql(
    `SELECT short_id FROM items WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'southbeam')
     ORDER BY seq LIMIT 1`,
  );
  await page.goto(`/thread/${shortId}`);
  await expect(page).toHaveTitle(new RegExp(shortId));
});

test("the Settings checklist's email step opens the email card", async ({ page }) => {
  await page.goto("/settings");
  const step = page.getByRole("link", { name: /Wire email delivery/ });
  await expect(step).toHaveAttribute("href", "/settings#email-delivery");

  await step.click();
  await expect(page).toHaveURL(/\/settings#email-delivery$/);
  const card = page.locator("#email-delivery");
  await expect(card).toContainText("Email delivery");
  // Below the fold until the anchor scrolls it up.
  await expect(card).toBeInViewport({ ratio: 1 });
});

test.describe("a brand-new workspace", () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // signs in as its admin

  const tag = Date.now();
  const SLUG = `e2e-fresh-${tag}`;
  const EMAIL = `fresh+${tag}@example.com`;

  test.beforeAll(() => {
    // As /onboard makes one on self-host (lib/provision.ts: no sample data),
    // with the first-sign-in tour already done, like setup.ts.
    psql(
      `WITH w AS (INSERT INTO workspaces (slug, name) VALUES ('${SLUG}', 'E2E Fresh ${tag}') RETURNING id)
       INSERT INTO workspace_users (workspace_id, email, name, role, initials, guide_completed_at)
       SELECT id, '${EMAIL}', 'Fresh Admin', 'admin', 'FA', now() FROM w`,
    );
  });

  test.afterAll(() => {
    psql(`DELETE FROM workspaces WHERE slug = '${SLUG}'`);
  });

  test("its empty inbox leads with the setup checklist; accounts point to the widget", async ({ page }) => {
    await page.goto(mintMagicLink(EMAIL));
    await page.getByRole("button", { name: "Continue to Crumb" }).click();
    await expect(page).toHaveURL(/\/inbox$/);

    const checklist = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Setup", exact: true }) });
    const install = checklist.getByRole("link", { name: /Install the widget/ });
    await expect(install).toHaveAttribute("href", "/settings/install");
    await expect(install).toContainText("Set up");
    await expect(page.getByText(/Nothing.s landed yet/)).toBeVisible();

    await page.goto("/accounts");
    await expect(page.getByText("No accounts yet")).toBeVisible();
    await page.getByRole("link", { name: "Install the widget" }).click();
    await expect(page).toHaveURL(/\/settings\/install$/);
  });
});
