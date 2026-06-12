import { test, expect } from "@playwright/test";

// The per-row "⋯" action menu: single-item triage without the checkbox→bulk
// flow. Covers assign (avatar updates in place) and status (item moves to the
// Closed tab via the loop-turn derivation).

test("row ⋯ menu assigns a teammate in place", async ({ page }) => {
  await page.goto("/inbox");

  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  const row = page.locator(".list-row", { hasText: shortId });

  await row.getByRole("button", { name: `Actions for ${shortId}` }).click();
  await page.getByRole("menu").getByText("Assign to…").click();
  await page.getByRole("menu").getByText("Ravi Patel").click();

  // The row's assignee avatar shows the new initials after refresh.
  await expect(row.getByText("RP", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("row ⋯ menu sets status and the loop moves to Closed", async ({ page }) => {
  await page.goto("/inbox");

  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  const row = page.locator(".list-row", { hasText: shortId });

  await row.getByRole("button", { name: `Actions for ${shortId}` }).click();
  await page.getByRole("menu").getByText("Set status…").click();
  await page.getByRole("menu").getByText("Shipped").click();

  // Shipped is a terminal status: the loop closes, so the item leaves the
  // default "Your turn" tab and appears under Closed.
  await expect(page.locator(".list-row", { hasText: shortId })).toHaveCount(0, { timeout: 10_000 });
  await page.locator(".seg button", { hasText: /Closed/ }).click();
  await expect(page.locator(".list-row", { hasText: shortId })).toBeVisible({ timeout: 10_000 });
});
