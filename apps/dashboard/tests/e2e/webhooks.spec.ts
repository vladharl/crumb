import { test, expect } from "@playwright/test";

test("can add a webhook endpoint and then delete it", async ({ page }) => {
  await page.goto("/settings/webhooks");

  const url = `https://example.com/hook-${Date.now()}`;
  await page.getByPlaceholder(/your-app\.example\.com/i).fill(url);
  await page.getByRole("button", { name: /Add endpoint/i }).click();

  // The new endpoint row (showing its URL) streams in after router.refresh().
  await expect(page.getByText(url, { exact: true })).toBeVisible({ timeout: 10_000 });
  // The one-time signing secret is surfaced on create.
  await expect(page.getByText(/save this signing secret/i)).toBeVisible();

  // Delete it again, confirming in the dialog.
  await page.getByRole("button", { name: /^Delete$/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(url, { exact: true })).toBeHidden({ timeout: 10_000 });
});
