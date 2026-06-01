import { test, expect } from "@playwright/test";
import { submitWidgetItem } from "./helpers";

// Auto-triage (#3) writes severity/sentiment + a suggested assignee at capture.
// Cloud tier + the AI stub (deterministic). Triage is fire-and-forget, so we
// reload /inbox until the badge renders.

test("auto-triage badges + accept the suggested assignee", async ({ page, request }) => {
  const tag = Date.now();
  // Neutral wording → the stub returns severity "medium" (no negative keywords).
  const title = `Add a CSV export option ${tag}`;
  await submitWidgetItem(request, { email: `casey+${tag}@acme.co`, accountName: "Acme Co", name: "Casey", type: "idea", title, body: "It would help to export to CSV." });

  await expect(async () => {
    await page.goto("/inbox");
    await expect(page.locator(".list-row", { hasText: title }).getByText("medium")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });

  // The AI-suggested assignee chip is present; accepting it assigns the item
  // (router.refresh removes the chip).
  const row = page.locator(".list-row", { hasText: title });
  await row.getByRole("button", { name: /Assign to/i }).click();
  await expect(row.getByRole("button", { name: /Assign to/i })).toHaveCount(0, { timeout: 15_000 });
});
