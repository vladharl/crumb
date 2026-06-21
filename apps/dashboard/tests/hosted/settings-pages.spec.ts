import { test, expect } from "@playwright/test";
import { hasSession, IS_CLOUD_EDITION } from "./fixtures";

// The admin settings surfaces render and show the expected integration cards /
// affordances. Requires a dashboard session. Read-only (we never submit any of
// these forms — minting keys / adding endpoints would mutate state).

const SESSION = hasSession();

test.describe("settings pages render", () => {
  test.beforeEach(() => {
    test.skip(!SESSION, "no hosted dashboard session — set CRUMB_E2E_SESSION (or CRUMB_E2E_SSH_BOOTSTRAP=1)");
  });

  test("integrations page shows every integration card", async ({ page }) => {
    await page.goto("/settings/integrations");
    for (const title of [
      "Linear", "Jira", "GitHub", "HubSpot", "Salesforce",
      "Vendor-side Slack", "Microsoft Teams", "Session record",
    ]) {
      await expect(page.getByText(title, { exact: false }).first(), `card: ${title}`).toBeVisible();
    }
  });

  test("session-record is cloud-gated on a self-host build", async ({ page }) => {
    test.skip(IS_CLOUD_EDITION, "cloud edition exposes session record — gating copy differs");
    await page.goto("/settings/integrations");
    // Self-host, not entitled → the card explains it's a Cloud feature.
    await expect(page.getByText("Session record is available on Crumb Cloud", { exact: false })).toBeVisible();
  });

  test("API keys page renders its create affordance", async ({ page }) => {
    await page.goto("/settings/api-keys");
    await expect(page.getByRole("button", { name: /Create key/i })).toBeVisible();
  });

  test("webhooks page renders its add-endpoint affordance", async ({ page }) => {
    await page.goto("/settings/webhooks");
    await expect(page.getByRole("button", { name: /Add endpoint/i })).toBeVisible();
  });
});
