import { test, expect } from "@playwright/test";

test("inbox renders the seeded items with the expected columns", async ({ page }) => {
  await page.goto("/inbox");

  // The PageHead title is rendered immediately (server-side streaming).
  await expect(page.getByRole("heading", { name: /^Inbox$/ })).toBeVisible();

  // Column headers — these are static in the table chrome, so they appear
  // even while the Suspense skeleton is still resolving.
  await expect(page.getByRole("row").first()).toContainText("Title");
  await expect(page.getByRole("row").first()).toContainText("Account");
  await expect(page.getByRole("row").first()).toContainText("Status");

  // At least one seeded FB-N row resolves after the tile streams in.
  await expect(page.locator("text=/FB-\\d+/").first()).toBeVisible({ timeout: 10_000 });
});
