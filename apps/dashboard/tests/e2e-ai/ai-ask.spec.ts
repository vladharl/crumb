import { test, expect } from "@playwright/test";
import { submitWidgetItem } from "./helpers";

// "Ask your feedback" (#5). Submit an embedded item, then ask a question — the
// stub answer echoes a [FB-N] citation from the retrieved context, which the UI
// renders as a clickable source chip.

test("Ask returns a cited answer", async ({ page, request }) => {
  const tag = Date.now();
  await submitWidgetItem(request, {
    email: `cara+${tag}@acme.co`, accountName: "Acme Co", name: "Cara",
    type: "idea", title: `Bulk CSV export before renewal ${tag}`,
    body: "Enterprise wants bulk CSV export before renewing.",
  });
  // Let the embedding land so retrieval has something to cite.
  await new Promise((r) => setTimeout(r, 3000));

  await page.goto("/ask");
  await page.getByPlaceholder(/Ask anything/i).fill("What do enterprise accounts want before renewal?");
  await page.getByRole("button", { name: /^Ask$/ }).click();

  // A citation chip (FB-N) appears in the answer.
  await expect(page.getByText(/FB-\d+/).first()).toBeVisible({ timeout: 30_000 });
});
