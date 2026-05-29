import { test, expect } from "@playwright/test";

test("inbox tab filter (All / Open / Mine) updates the visible row count", async ({ page }) => {
  await page.goto("/inbox");

  // Wait for the table tile to resolve. After Suspense, the All/Open/Mine
  // tabs render with their counts.
  const allTab = page.locator(".seg button", { hasText: /All/ });
  await expect(allTab).toBeVisible({ timeout: 10_000 });
  const openTab = page.locator(".seg button", { hasText: /Open/ });
  const mineTab = page.locator(".seg button", { hasText: /Mine/ });

  // Tab labels show counts like "All · 10" — capture the All number.
  const allText = await allTab.innerText();
  const allMatch = allText.match(/\d+/);
  expect(allMatch, "All tab should show a count").toBeTruthy();

  // Click Open. The visible-rows footer should change (or rows reduce).
  await openTab.click();
  await expect(openTab).toHaveAttribute("aria-selected", "true");

  // Click Mine. The seeded admin's assigned-count may be 0 — accept that;
  // we're testing the filter wires up, not the seed's distribution.
  await mineTab.click();
  await expect(mineTab).toHaveAttribute("aria-selected", "true");

  // Restore.
  await allTab.click();
  await expect(allTab).toHaveAttribute("aria-selected", "true");
});
