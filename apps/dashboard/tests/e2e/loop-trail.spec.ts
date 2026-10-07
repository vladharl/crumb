import { test, expect } from "@playwright/test";

// The loop reframe end-to-end: replying to a customer flips the item from
// "Your turn" to "Waiting" in the inbox. The e2e run uses the stdout email
// provider, which delivers nothing, so the composer says the customer wasn't
// emailed and the Trail shows no "was notified" crumb: those come only from
// the customer_notifications ledger, which records emails a real provider
// accepted.
test("vendor reply closes the turn: no stdout notice in Trail, item moves to Waiting", async ({ page }) => {
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
  await page.getByRole("button", { name: /^Send (to |reply)/i }).click();
  await expect(page.locator("body")).toContainText(replyBody, { timeout: 15_000 });
  await expect(page.getByText(/Reply posted\. .+ wasn't emailed\./)).toBeVisible({ timeout: 10_000 });

  // The Trail has the reply but no notice crumb: nothing was delivered.
  await page.locator(".seg button", { hasText: /Trail/ }).click();
  const trail = page.locator(".trail-timeline");
  await expect(trail).toContainText(replyBody, { timeout: 10_000 });
  await expect(trail).not.toContainText("was notified of the reply");

  // Back in the inbox, the loop's turn flipped: gone from "Your turn",
  // present under "Waiting".
  await page.goto("/inbox");
  await expect(yoursTab).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".list-row", { hasText: shortId })).toHaveCount(0);
  await page.locator(".seg button", { hasText: /Waiting/ }).click();
  await expect(page.locator(".list-row", { hasText: shortId })).toBeVisible({ timeout: 10_000 });
});
