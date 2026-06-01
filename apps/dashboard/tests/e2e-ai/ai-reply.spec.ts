import { test, expect } from "@playwright/test";
import { submitWidgetItem } from "./helpers";

// Reply drafting + translation (#7), cloud tier + the deterministic stub.

test("AI draft fills the reply composer", async ({ page, request }) => {
  const tag = Date.now();
  const shortId = await submitWidgetItem(request, {
    email: `dee+${tag}@acme.co`, accountName: "Acme Co", name: "Dee",
    type: "question", title: `How do I export ${tag}?`, body: "Where is the export option?",
  });
  await page.goto(`/thread/${shortId}`);
  await page.getByRole("button", { name: /AI draft/i }).click();
  await expect(page.getByPlaceholder(/Write a reply/i)).toHaveValue(/Thanks for flagging this/i, { timeout: 20_000 });
});

test("foreign-language feedback can be translated", async ({ page, request }) => {
  const tag = Date.now();
  const shortId = await submitWidgetItem(request, {
    email: `pablo+${tag}@acme.co`, accountName: "Acme Co", name: "Pablo",
    type: "idea", title: `Necesitamos exportar a CSV ${tag}`, body: "Por favor, necesitamos exportar.",
  });

  // Triage stamps detected_lang = es (fire-and-forget) → the banner appears.
  await expect(async () => {
    await page.goto(`/thread/${shortId}`);
    await expect(page.getByText(/This feedback is in/i)).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });

  await page.getByRole("button", { name: /Translate to English/i }).click();
  await expect(page.getByText(/Translated text \(e2e stub\)/i).first()).toBeVisible({ timeout: 20_000 });
});
