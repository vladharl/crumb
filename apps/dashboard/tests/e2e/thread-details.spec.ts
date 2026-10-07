import { test, expect } from "@playwright/test";

// The thread's Details card: single-item assignee + type edits in place
// (previously display-only; assignment used to require the inbox bulk bar).

test("thread Details card edits assignee and type in place", async ({ page }) => {
  await page.goto("/inbox");
  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  // The row's title link covers the row, so click it rather than the id cell.
  await page.locator(`a.row-link[href="/thread/${shortId}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/thread/${shortId}$`), { timeout: 60_000 });

  const details = page.locator(".card", { hasText: "Details" }).first();
  await expect(details).toBeVisible({ timeout: 10_000 });

  // Assign to a teammate via the Details dropdown.
  await details.getByRole("button", { name: "Assignee" }).click();
  await page.getByRole("option", { name: "Sarah Klein" }).click();
  await expect(details.getByRole("button", { name: "Assignee" })).toContainText("Sarah Klein", { timeout: 10_000 });

  // Change the type; persists across a reload.
  await details.getByRole("button", { name: "Type" }).click();
  await page.getByRole("option", { name: "Bug" }).click();
  await expect(details.getByRole("button", { name: "Type" })).toContainText("Bug", { timeout: 10_000 });

  await page.reload();
  const detailsAfter = page.locator(".card", { hasText: "Details" }).first();
  await expect(detailsAfter.getByRole("button", { name: "Assignee" })).toContainText("Sarah Klein", { timeout: 10_000 });
  await expect(detailsAfter.getByRole("button", { name: "Type" })).toContainText("Bug");
});
