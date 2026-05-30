import { test, expect } from "@playwright/test";

// The roadmap is folded into the Initiatives board: one page with
// Unscheduled / Now / Next / Later columns. (The seed has no initiatives, so
// columns render empty; we assert the board chrome, not specific cards.)
test("initiatives renders the Now/Next/Later board", async ({ page }) => {
  await page.goto("/initiatives");
  await expect(page.getByRole("heading", { name: /^Initiatives$/ })).toBeVisible();
  await expect(page.getByText("Now", { exact: true })).toBeVisible();
  await expect(page.getByText("Next", { exact: true })).toBeVisible();
  await expect(page.getByText("Later", { exact: true })).toBeVisible();
  await expect(page.getByText("Unscheduled", { exact: true })).toBeVisible();
  // The old stub copy is gone.
  await expect(page.getByText(/Coming soon/i)).toHaveCount(0);
});

test("/roadmap redirects to the Initiatives board", async ({ page }) => {
  await page.goto("/roadmap");
  await expect(page).toHaveURL(/\/initiatives$/);
});

test("public roadmap API returns the grouped shape", async ({ page }) => {
  const res = await page.request.get("/api/v1/roadmap?workspace=northbeam&email=maya@acme.co");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.columns).toHaveProperty("now");
  expect(body.columns).toHaveProperty("next");
  expect(body.columns).toHaveProperty("later");
});
