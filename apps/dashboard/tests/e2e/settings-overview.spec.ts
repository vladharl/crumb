import { test, expect } from "@playwright/test";

// /settings is now a setup-state overview (was a redirect to Team). The
// checklist derives each step from live data, so the seeded fixture gives
// deterministic done/todo states.

test("settings overview shows the setup checklist with derived states", async ({ page }) => {
  await page.goto("/settings");

  // No redirect — the Overview renders in place.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText("Setup", { exact: true })).toBeVisible({ timeout: 10_000 });

  // All five steps render.
  for (const label of [
    "Install the widget",
    "Invite your team",
    "Wire email delivery",
    "Connect a tool",
    "Publish your roadmap",
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  // Seed facts: items exist and 4 teammates are seeded → both done. The e2e
  // env has no email provider and no integrations → at least those two todo.
  const checklist = page.locator(".card", { hasText: "Setup" }).first();
  await expect(checklist.locator("a", { hasText: "Install the widget" })).toContainText("Done");
  await expect(checklist.locator("a", { hasText: "Invite your team" })).toContainText("Done");
  await expect(checklist.locator("a", { hasText: "Wire email delivery" })).toContainText("Set up");
  await expect(checklist.locator("a", { hasText: "Connect a tool" })).toContainText("Set up");

  // The email delivery card moved here from Audit (admin sees the guidance).
  await expect(page.getByText("Email delivery", { exact: true })).toBeVisible();

  // The grouped nav renders its job-ordered sections.
  for (const group of ["Set up", "Connections", "Workspace", "You"]) {
    await expect(page.locator(".eyebrow", { hasText: group }).first()).toBeVisible();
  }

  // Checklist rows link onward.
  await checklist.locator("a", { hasText: "Invite your team" }).click();
  await expect(page).toHaveURL(/\/settings\/team$/);
});
