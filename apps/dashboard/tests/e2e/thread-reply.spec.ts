import { test, expect } from "@playwright/test";

test("opening a thread and posting a vendor reply adds a new message", async ({ page }) => {
  await page.goto("/inbox");

  // Wait for the table tile to resolve, then click the first FB-N link.
  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  await firstRowId.click();

  // Land on /thread/{shortId}. The crumb shows the same id. The generous
  // timeout absorbs Next dev's cold first-compile of the /thread/[shortId]
  // route, which can take tens of seconds on a slow box (irrelevant in a
  // prebuilt/CI run, but this keeps the test from flaking locally).
  await expect(page).toHaveURL(new RegExp(`/thread/${shortId}$`), { timeout: 60_000 });
  await expect(page.locator("body")).toContainText(shortId, { timeout: 10_000 });

  // Compose a reply. The composer textarea + send button live in the
  // ThreadView client component. The button names who it reaches ("Send to
  // Maya", or "Send reply" when nobody gets emailed); the pattern skips the
  // "Send and mark …" buttons beside it.
  const composer = page.getByPlaceholder(/reply|message|type/i).first();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  const replyBody = `e2e reply ${Date.now()}`;
  await composer.fill(replyBody);

  await page.getByRole("button", { name: /^Send (to |reply)/i }).click();

  // The new reply appears in the customer-tab view (default tab). Allow
  // headroom for the server action round-trip + revalidation.
  await expect(page.locator("body")).toContainText(replyBody, { timeout: 15_000 });
});
