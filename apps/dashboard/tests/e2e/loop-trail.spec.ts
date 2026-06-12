import { test, expect } from "@playwright/test";

// The loop reframe end-to-end: replying to a customer logs a row in the
// customer_notifications ledger (stdout email provider counts as delivered),
// which surfaces in the thread's Trail as "<name> was notified of the reply",
// and flips the item from "Your turn" to "Waiting" in the inbox.
test("vendor reply closes the turn: ledger crumb in Trail, item moves to Waiting", async ({ page }) => {
  await page.goto("/inbox");

  // Land on the default "Your turn" tab and open its first item.
  const yoursTab = page.locator(".seg button", { hasText: /Your turn/ });
  await expect(yoursTab).toBeVisible({ timeout: 10_000 });
  await expect(yoursTab).toHaveAttribute("aria-selected", "true");

  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  await firstRowId.click();
  await expect(page).toHaveURL(new RegExp(`/thread/${shortId}$`), { timeout: 60_000 });

  // Post a customer-facing reply.
  const composer = page.getByPlaceholder(/reply|message|type/i).first();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  const replyBody = `loop e2e reply ${Date.now()}`;
  await composer.fill(replyBody);
  await page.getByRole("button", { name: /^send$|^reply$/i }).click();
  await expect(page.locator("body")).toContainText(replyBody, { timeout: 15_000 });

  // The Trail shows the ledger crumb: the customer actually heard back.
  await page.locator(".seg button", { hasText: /Trail/ }).click();
  await expect(page.locator("body")).toContainText("was notified of the reply", { timeout: 10_000 });

  // Back in the inbox, the loop's turn flipped: gone from "Your turn",
  // present under "Waiting".
  await page.goto("/inbox");
  await expect(yoursTab).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".list-row", { hasText: shortId })).toHaveCount(0);
  await page.locator(".seg button", { hasText: /Waiting/ }).click();
  await expect(page.locator(".list-row", { hasText: shortId })).toBeVisible({ timeout: 10_000 });
});
