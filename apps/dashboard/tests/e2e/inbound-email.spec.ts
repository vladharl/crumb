import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

// Forwarded-email → pending capture → confirm → item. Runs at self_host tier
// (admin signed-in via the default storageState). CRUMB_INBOUND_SECRET +
// CRUMB_WEBHOOK_ALLOW_ANY are set by the webServer env in playwright.config.ts.

const SECRET = "e2e-inbound";

function inboxToken(slug: string): string {
  const mac = createHmac("sha256", SECRET).update(slug.toLowerCase()).digest().subarray(0, 16);
  return mac.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

test("forwarded email creates a pending capture you can confirm", async ({ page, request }) => {
  const tag = Date.now();
  const body = `Please add CSV export ${tag}.`;
  const addr = `inbox+southbeam.${inboxToken("southbeam")}@crumb.test`;

  const resp = await request.post("/api/v1/inbound/email", {
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    data: {
      to: addr,
      from: `Casey <casey+${tag}@acme.co>`,
      subject: `Feature request ${tag}`,
      text: `${body}\nOn Mon, someone wrote:\n> quoted history ${tag}`,
    },
  });
  expect(resp.ok()).toBeTruthy();
  expect((await resp.json()).ok).toBe(true);

  // The capture shows on /captures with the quoted tail stripped. (The body
  // appears in both the preview and the editable textarea, hence .first().)
  await page.goto("/captures");
  await expect(page.getByText(body).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`quoted history ${tag}`)).toHaveCount(0);

  // Confirm → map to a seeded account and create the item.
  const card = page.locator(".card", { hasText: body });
  await card.getByPlaceholder(/Map to a customer account/i).fill("Acme Co");
  await card.getByRole("button", { name: /Create item/i }).click();

  // The capture leaves the pending list once accepted.
  await expect(page.getByText(body)).toHaveCount(0, { timeout: 15_000 });
});

test("inbound email with a bad token is rejected", async ({ request }) => {
  const resp = await request.post("/api/v1/inbound/email", {
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    data: { to: "inbox+southbeam.badtoken@crumb.test", from: "x@y.com", text: "hi" },
  });
  expect(resp.status()).toBe(403);
});
