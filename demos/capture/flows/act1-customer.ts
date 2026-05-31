import type { Page } from "@playwright/test";
import { shot, demoClick, demoType, pause } from "../lib";

// ACT 1 — THE CUSTOMER.
// A customer, inside their own product (the mock Southbeam analytics page),
// opens the embedded Crumb widget, drops a piece of feedback, and then checks
// the public roadmap — all without leaving the app they're using.
//
// The widget renders in an OPEN shadow DOM, so ordinary Playwright CSS
// locators pierce it automatically. Selectors verified against
// apps/widget/src/widget.ts (data-act / data-tab / .type-btn / .rm-card).
export const name = "act1-customer";

export async function record(page: Page): Promise<void> {
  // The mock host product with the widget embedded (identity defaults to
  // maya@acme.co / Acme Co — a seeded customer).
  await page.goto("/widget-demo.html", { waitUntil: "networkidle" });
  await pause(page, 1400);
  await shot(page, "act1-1-host-product");

  // Open the launcher → the panel slides in.
  const launcher = page.locator(".launcher");
  await launcher.waitFor({ state: "visible", timeout: 15_000 });
  await demoClick(page, launcher);
  await page.locator(".panel.open").waitFor({ timeout: 10_000 });
  await pause(page, 800);

  // Start a new piece of feedback.
  await demoClick(page, page.locator('[data-act="new"]').first());
  await page.locator('input[data-act="title"]').waitFor({ timeout: 10_000 });
  await pause(page, 400);

  // Pick a type, then write it out — completing each field before moving on.
  await demoClick(page, page.locator('.type-btn[data-type="idea"]'));
  await demoType(page, page.locator('input[data-act="title"]'),
    "Export the cohort table to CSV");
  await demoType(page, page.locator('textarea[data-act="body"]'),
    "We rebuild this by hand for every board deck — a one-click CSV would save us hours each quarter.");
  await pause(page, 500);
  await shot(page, "act1-2-compose");

  // Send — and WAIT for the confirmation before doing anything else.
  await demoClick(page, page.locator('[data-act="submit"]'));
  await page.locator(".empty .short-id").waitFor({ timeout: 15_000 });
  await pause(page, 1400);
  await shot(page, "act1-3-received");

  // Now check the public roadmap. Confirmation → list → Roadmap tab.
  await demoClick(page, page.locator('[data-act="see-list"]'));
  await page.locator('[data-act="tab"][data-tab="roadmap"]').waitFor({ timeout: 10_000 });
  await demoClick(page, page.locator('[data-act="tab"][data-tab="roadmap"]'));
  await page.locator(".rm-card").first().waitFor({ timeout: 10_000 });
  await pause(page, 1600);
  await shot(page, "act1-4-roadmap");
  await pause(page, 900);
}
