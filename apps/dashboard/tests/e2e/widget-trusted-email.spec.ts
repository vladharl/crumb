import { test, expect } from "@playwright/test";
import { psql } from "./helpers/mint";
import { SLUG, openPanel, startWidgetHost } from "./helpers/widget-host";

// Self-host's plain-email snippet (data-user-email + data-account-name, no
// signed token). The customer's row is created by their first submission, so
// before that the list and uploads must treat them as new, not as signed out.
// This suite runs on the self_host tier, where the trusted-email path is open.

test.use({ storageState: { cookies: [], origins: [] }, locale: "en-GB" }); // the customer: no dashboard session

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let host: Awaited<ReturnType<typeof startWidgetHost>>;
test.beforeAll(async ({ baseURL }) => { host = await startWidgetHost(baseURL!); });
test.afterAll(async () => { await host.close(); });

test("a brand-new trusted-email customer sees an empty inbox and can attach before the first send", async ({ page }) => {
  const email = `trusted-${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
  await page.goto(host.url("/", { "user-email": email, "account-name": "Trusted Co", "user-name": "Tess Trusted" }));

  const dialog = await openPanel(page);
  await expect(dialog.getByRole("heading", { name: "Got something to share?" })).toBeVisible();
  await expect(dialog).not.toContainText("signed in");

  await dialog.getByRole("button", { name: "Share feedback" }).first().click();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Export button greys out");
  await dialog.getByRole("textbox", { name: /^Details/ }).fill("Screenshot attached.");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles({ name: "export.png", mimeType: "image/png", buffer: PNG });
  await expect(dialog.getByRole("button", { name: "Remove export.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Feedback sent" })).toBeVisible();
  const shortId = (await dialog.locator(".short-id").innerText()).trim();

  // One item, one customer row, the file on the first message.
  const rows = psql(
    `SELECT au.name, a.name, (SELECT string_agg(f.filename, ',') FROM replies r JOIN attachments f ON f.reply_id = r.id WHERE r.item_id = i.id)
     FROM items i JOIN workspaces w ON w.id = i.workspace_id
     JOIN account_users au ON au.id = i.submitter_id JOIN accounts a ON a.id = i.account_id
     WHERE w.slug = '${SLUG}' AND i.short_id = '${shortId}'`,
  ).split("\n");
  expect(rows).toEqual(["Tess Trusted|Trusted Co|export.png"]);
});
