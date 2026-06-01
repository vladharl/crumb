import { test, expect } from "@playwright/test";

test("insights renders KPIs and the status funnel from seeded data", async ({ page }) => {
  await page.goto("/insights");

  await expect(page.getByRole("heading", { name: /^Insights$/ })).toBeVisible();

  // KPI labels are static chrome; values come from SQL over the seed.
  await expect(page.getByText("Total feedback")).toBeVisible();
  await expect(page.getByText("Median first response")).toBeVisible();

  // The trend card + status funnel + a known seeded status row.
  await expect(page.getByText("Feedback over time")).toBeVisible();
  await expect(page.getByText("Status funnel")).toBeVisible();
  await expect(page.getByText(/Open|In review/).first()).toBeVisible({ timeout: 10_000 });

  // QBR + CSV export controls are present.
  await expect(page.getByRole("link", { name: /QBR report/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Export CSV/i })).toBeVisible();
});
