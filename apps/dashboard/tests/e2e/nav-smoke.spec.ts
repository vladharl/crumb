import { test, expect } from "@playwright/test";

// Smoke-test every primary destination: it must render (not redirect to
// /login), surface the app shell, and throw no uncaught errors. Guards
// against a page silently 500-ing or a nav link going nowhere.

const PAGES = [
  "/inbox",
  "/accounts",
  "/initiatives",
  "/insights",
  "/notifications",
  "/settings",
  "/settings/team",
  "/settings/integrations",
  "/settings/webhooks",
  "/settings/account-mapping",
  "/settings/branding",
  "/settings/install",
  "/settings/audit",
  "/settings/billing",
];

for (const path of PAGES) {
  test(`renders ${path} without errors`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await page.goto(path);

    // Not bounced to login (auth/session intact).
    await expect(page).not.toHaveURL(/\/login/);
    // App shell present — the top-bar nav renders its Inbox link on every page
    // (Settings moved into the avatar menu with the top-bar redesign).
    await expect(page.getByRole("navigation").getByRole("link", { name: /Inbox/i })).toBeVisible({ timeout: 10_000 });
    // No uncaught client exceptions.
    expect(pageErrors, `uncaught errors on ${path}: ${pageErrors.join(" | ")}`).toEqual([]);
  });
}
