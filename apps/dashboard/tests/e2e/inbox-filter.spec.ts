import { test, expect } from "@playwright/test";

test("inbox turn tabs (Your turn / Waiting / Closed / Mine / All) update the visible rows", async ({ page }) => {
  await page.goto("/inbox");

  // Wait for the table tile to resolve. After Suspense, the turn tabs render
  // with their counts; "Your turn" is the default landing tab.
  const yoursTab = page.locator(".seg button", { hasText: /Your turn/ });
  await expect(yoursTab).toBeVisible({ timeout: 10_000 });
  await expect(yoursTab).toHaveAttribute("aria-selected", "true");

  const waitingTab = page.locator(".seg button", { hasText: /Waiting/ });
  const closedTab = page.locator(".seg button", { hasText: /Closed/ });
  const mineTab = page.locator(".seg button", { hasText: /Mine/ });
  const allTab = page.locator(".seg button", { hasText: /All/ });

  // Tab labels show counts like "All · 10" — capture the All number.
  const allText = await allTab.innerText();
  const allMatch = allText.match(/\d+/);
  expect(allMatch, "All tab should show a count").toBeTruthy();

  // The three turn buckets partition All: yours + waiting + closed = all.
  const count = async (tab: typeof allTab) =>
    parseInt((await tab.innerText()).match(/\d+/)?.[0] ?? "0", 10);
  expect((await count(yoursTab)) + (await count(waitingTab)) + (await count(closedTab)))
    .toBe(await count(allTab));

  // Each tab wires up (selection follows clicks).
  for (const tab of [waitingTab, closedTab, mineTab, allTab, yoursTab]) {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
});

test("initiative filter scopes the tab counts, not just the rows", async ({ page }) => {
  await page.goto("/inbox");

  const allTab = page.locator(".seg button", { hasText: /All/ });
  await expect(allTab).toBeVisible({ timeout: 10_000 });
  const count = async (tab: typeof allTab) =>
    parseInt((await tab.innerText()).match(/\d+/)?.[0] ?? "0", 10);
  const unfilteredAll = await count(allTab);

  // Pick the first real initiative from the filter dropdown.
  await page.getByRole("button", { name: "Filter by initiative" }).click();
  await page.getByRole("option").nth(2).click(); // 0 = all, 1 = no initiative

  // Counts re-scope: the turn buckets still partition All, and All matches
  // the visible rows on the All tab (i.e. counts respect the filter).
  const yoursTab = page.locator(".seg button", { hasText: /Your turn/ });
  const waitingTab = page.locator(".seg button", { hasText: /Waiting/ });
  const closedTab = page.locator(".seg button", { hasText: /Closed/ });
  await expect
    .poll(async () => (await count(yoursTab)) + (await count(waitingTab)) + (await count(closedTab)))
    .toBe(await count(allTab));

  const filteredAll = await count(allTab);
  expect(filteredAll).toBeLessThan(unfilteredAll);
  await allTab.click();
  await expect(page.locator(".list-row:not(.head)")).toHaveCount(filteredAll);
});
