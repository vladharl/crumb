import { test, expect } from "@playwright/test";
import { mintSetupLink, psql } from "./helpers/mint";

// The self-host way in: a one-time setup link (`cli setup-link`, or printed to
// the container logs on a fresh instance) opens /onboard, which creates a new
// workspace and its admin and signs them in (app/onboard). The link works once.
// An instance that already has a workspace (this one: southbeam) sends anyone
// without a valid link to sign in; the "open your setup link" page is only for
// an instance with no workspace at all, which a shared e2e DB can't be.

test.use({ storageState: { cookies: [], origins: [] } }); // an operator with no account yet

const tag = Date.now();
const NAME = `E2E First Run ${tag}`;
const SLUG = `e2e-first-run-${tag}`; // what the form derives from NAME
const CREATE = { name: "Create workspace & sign in" };

test.afterAll(() => {
  psql(`DELETE FROM workspaces WHERE slug LIKE '${SLUG}%'`);
});

test("a setup link creates a workspace and its signed-in admin, once", async ({ page, context }) => {
  const link = mintSetupLink();

  // A second tab holds the same form open, to submit after the link is spent.
  const stale = await context.newPage();
  await stale.goto(link);

  await page.goto(link);
  await page.locator('input[name="workspaceName"]').fill(NAME);
  await expect(page.locator('input[name="slug"]')).toHaveValue(SLUG);
  await page.locator('input[name="adminName"]').fill("Fern Owner");
  await page.locator('input[name="adminEmail"]').fill(`fern+${tag}@example.com`);
  await page.getByRole("button", CREATE).click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.locator(".topbar-ws")).toHaveText(NAME);
  expect(psql(
    `SELECT wu.email, wu.role FROM workspace_users wu JOIN workspaces w ON w.id = wu.workspace_id
     WHERE w.slug = '${SLUG}'`,
  )).toBe(`fern+${tag}@example.com|admin`);

  // The action refuses the spent token, and creates nothing.
  await stale.locator('input[name="workspaceName"]').fill(`${NAME} again`);
  await stale.locator('input[name="adminName"]').fill("Someone Else");
  await stale.locator('input[name="adminEmail"]').fill(`else+${tag}@example.com`);
  await stale.getByRole("button", CREATE).click();
  await expect(stale.getByText("This setup link has expired.")).toBeVisible();
  expect(psql(`SELECT count(*) FROM workspaces WHERE slug = '${SLUG}-again'`)).toBe("0");

  // Opened again, signed out: no form, just sign-in.
  await context.clearCookies();
  await page.goto(link);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("/onboard without a valid link sends people to sign in", async ({ page }) => {
  for (const path of ["/onboard", "/onboard?token=not-a-setup-token"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  }
});
