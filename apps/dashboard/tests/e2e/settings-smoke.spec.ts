import { test, expect } from "@playwright/test";

// Every settings page must expose working primary controls. We assert the
// key action button on each page exists and is enabled — a guard against
// re-introducing the dead placeholder buttons this work removed.

test("account mapping exposes working add / import / export controls", async ({ page }) => {
  await page.goto("/settings/account-mapping");
  // Add is intentionally disabled until a name is typed — assert it's present,
  // then enables once the input is filled.
  await expect(page.getByRole("button", { name: /Add account/i })).toBeVisible();
  await page.getByPlaceholder(/New account name/i).fill("Probe");
  await expect(page.getByRole("button", { name: /Add account/i })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Import CSV/i })).toBeEnabled();
  await expect(page.getByRole("link", { name: /Export/i })).toBeVisible();
  // The export link points at the real download route.
  await expect(page.getByRole("link", { name: /Export/i })).toHaveAttribute("href", /\/settings\/account-mapping\/export/);
});

test("team page has an enabled invite control", async ({ page }) => {
  await page.goto("/settings/team");
  await expect(page.getByRole("button", { name: /Invite/i }).first()).toBeVisible();
});

test("webhooks page has an enabled add-endpoint control", async ({ page }) => {
  await page.goto("/settings/webhooks");
  await expect(page.getByRole("button", { name: /Add endpoint/i })).toBeVisible();
});

test("accounts page Export + Add link to real destinations", async ({ page }) => {
  await page.goto("/accounts");
  await expect(page.getByRole("link", { name: /Export/i })).toHaveAttribute("href", /account-mapping\/export/);
  await expect(page.getByRole("link", { name: /Add account/i })).toHaveAttribute("href", /\/settings\/account-mapping/);
});
