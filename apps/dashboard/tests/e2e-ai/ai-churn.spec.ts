import { test, expect } from "@playwright/test";
import { submitWidgetItem } from "./helpers";

// Churn-risk (#6): a frustrated item (the stub returns sentiment -0.7 / high
// severity for negative wording) pushes its account into the Insights
// "Accounts at risk" card. Fire-and-forget triage → poll by reloading.

test("a negative item surfaces its account in the at-risk card", async ({ page, request }) => {
  const tag = Date.now();
  await submitWidgetItem(request, {
    email: `irate+${tag}@acme.co`, accountName: "Acme Co", name: "Irate",
    type: "bug", title: `Export is broken and we are frustrated ${tag}`,
    body: "This is terrible — totally unusable. We may cancel.",
  });

  await expect(async () => {
    await page.goto("/insights");
    const card = page.locator(".card", { hasText: "Accounts at risk" });
    await expect(card).toBeVisible({ timeout: 3000 });
    await expect(card.getByText("Acme Co")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
});
