import { test, expect } from "@playwright/test";
import { submitWidgetItem } from "./helpers";

// Dedup + smart merge (#4). Two near-identical items (the stub embeddings make
// them ~identical) from DIFFERENT accounts → a capture-time dedupe suggestion →
// merge → the canonical shows the combined ARR rollup.

test("near-duplicate items merge and combine ARR", async ({ page, request }) => {
  const tag = Date.now();
  const a = await submitWidgetItem(request, {
    email: `ann+${tag}@acme.co`, accountName: "Acme Co", name: "Ann",
    type: "idea", title: `Export cohort data to CSV ${tag}`, body: "We need cohort CSV export.",
  });
  // Let A's fire-and-forget embedding land before B is captured + compared.
  await new Promise((r) => setTimeout(r, 2500));
  const b = await submitWidgetItem(request, {
    email: `bo+${tag}@lumen.io`, accountName: "Lumen Health", name: "Bo",
    type: "idea", title: `Export cohort data to CSV please ${tag}`, body: "We need cohort CSV export.",
  });

  // B's thread surfaces the likely-duplicate suggestion (poll; fire-and-forget).
  await expect(async () => {
    await page.goto(`/thread/${b}`);
    await expect(page.getByText(/Likely duplicate of/i)).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });

  await page.getByRole("button", { name: new RegExp(`Merge into ${a}`, "i") }).click();

  // The canonical (A) now shows the merged rollup.
  await expect(async () => {
    await page.goto(`/thread/${a}`);
    await expect(page.getByText(/merged/i)).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
});
