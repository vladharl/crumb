import type { Page } from "@playwright/test";
import { shot, demoClick, demoType, pause, smoothScrollTo, readingScroll } from "../lib";

// ACT 2 — THE VENDOR CLOSES THE LOOP.
// The same feedback lands in the vendor's inbox. They open it, reply to the
// customer, and put the work on the public roadmap that customers can see.
// Centered on the hero thread FB-247 ("Bulk export from cohort view as CSV"),
// which carries the seeded reply chain + the $186k-ARR internal note.
export const name = "act2-vendor-loop";

export async function record(page: Page): Promise<void> {
  // 1 — The triage queue.
  await page.goto("/inbox", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^Inbox$/ }).waitFor({ timeout: 20_000 });
  await page.locator("text=/FB-\\d+/").first().waitFor({ timeout: 15_000 });
  await pause(page, 1200);
  await shot(page, "act2-1-inbox");

  // 2 — Open the hero thread.
  const hero = page.locator("text=Bulk export from cohort view as CSV").first();
  const target = (await hero.isVisible().catch(() => false))
    ? hero
    : page.locator("text=/FB-\\d+/").first();
  await demoClick(page, target);
  await page.waitForURL(/\/thread\/FB-\d+$/, { timeout: 30_000 });
  await page.locator("body").waitFor();
  await pause(page, 1000);
  await shot(page, "act2-2-thread");

  // Read down the thread so the customer↔vendor exchange registers.
  await readingScroll(page, 360);
  await readingScroll(page, 360);

  // 3 — Reply to the customer. Type, send, and WAIT for the reply to land
  // (the "Sent" pill / the new bubble) before moving on — no cut-off.
  const composer = page.getByPlaceholder(/reply|message|type|write/i).first();
  if (await composer.isVisible().catch(() => false)) {
    const replyText = "Shipping per-cohort CSV in v2.4 — out before your QBR. I've put it on the roadmap so you can follow along.";
    await demoType(page, composer, replyText);
    await pause(page, 300);
    const send = page.getByRole("button", { name: /^send$|^reply$/i }).first();
    await demoClick(page, send);
    // Wait for the reply text to appear in the message list (server round-trip).
    await page.locator(`text=${replyText.slice(0, 32)}`).first()
      .waitFor({ timeout: 15_000 }).catch(() => {});
    await pause(page, 1200);
    await shot(page, "act2-3-reply-sent");
  }

  // 4 — Show the item is tied to a roadmap initiative (sidebar card).
  const initiativeCard = page.locator("text=/CSV & funnel exports/i").first();
  if (await initiativeCard.isVisible().catch(() => false)) {
    await smoothScrollTo(page, initiativeCard, "center");
    await pause(page, 900);
  }

  // 5 — The roadmap board: put the customer's ask in front of customers.
  // "CSV & funnel exports" is staged Private; flipping its Public switch is the
  // exact control that makes it visible on the customer roadmap.
  await page.goto("/initiatives", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^Initiatives$/ }).waitFor({ timeout: 20_000 });
  await page.getByText("CSV & funnel exports", { exact: true }).first().waitFor({ timeout: 10_000 });
  await pause(page, 1200);

  // The card wrapping the hero initiative that also contains the Public switch.
  const heroCard = page
    .locator("div")
    .filter({ hasText: "CSV & funnel exports" })
    .filter({ has: page.locator('button[role="switch"]') })
    .last();
  const publicSwitch = heroCard.getByRole("switch");
  if (await publicSwitch.isVisible().catch(() => false)) {
    await smoothScrollTo(page, heroCard, "center");
    await shot(page, "act2-4a-before-public");
    await demoClick(page, publicSwitch); // Private → Public
    await pause(page, 1300);
  }
  await shot(page, "act2-4-roadmap-board");
  await pause(page, 800);
}
