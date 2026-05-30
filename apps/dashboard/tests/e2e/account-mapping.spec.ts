import { test, expect } from "@playwright/test";

test("can add an account and it appears in the list", async ({ page }) => {
  await page.goto("/settings/account-mapping");

  const name = `E2E Co ${Date.now()}`;
  await page.getByPlaceholder(/New account name/i).fill(name);
  await page.getByRole("button", { name: /Add account/i }).click();

  // The panel calls router.refresh(); the new account row streams in.
  await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("CSV export returns a text/csv download", async ({ page }) => {
  const res = await page.request.get("/settings/account-mapping/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["content-disposition"]).toContain("attachment");
  const body = await res.text();
  expect(body.split("\n")[0]).toBe("account_name,email,name");
});
