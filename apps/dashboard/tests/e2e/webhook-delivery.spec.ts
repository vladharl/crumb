import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";

// Vendor Teams + customer Slack/Teams webhooks actually deliver a card. We stand
// up an in-process receiver (the dashboard, a separate process, posts to it over
// localhost). CRUMB_WEBHOOK_ALLOW_ANY=1 (webServer env) lets the SSRF guard
// allow the localhost receiver.

const PORT = 3940;
let server: Server;
const received: Array<{ path: string; body: string }> = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: b });
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("vendor Teams webhook delivers an Adaptive Card", async ({ page }) => {
  await page.goto("/settings/integrations");
  await page.getByPlaceholder(/webhook\.office\.com/i).fill(`http://localhost:${PORT}/teams-vendor`);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await page.getByRole("button", { name: /Send test/i }).click();
  await expect(page.getByText("Sent a test card.")).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => received.find((r) => r.path === "/teams-vendor")?.body ?? "", { timeout: 15_000 })
    .toContain("AdaptiveCard");
});

test("customer account Slack webhook delivers Block Kit", async ({ page }) => {
  await page.goto("/accounts");
  await page.getByText("Acme Co").click();
  await page.getByPlaceholder(/hooks\.slack\.com/i).fill(`http://localhost:${PORT}/slack-acct`);
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 15_000 });

  // "Send test" for the now-configured Slack channel.
  await page.getByRole("button", { name: /Send test/i }).first().click();

  await expect.poll(() => received.find((r) => r.path === "/slack-acct")?.body ?? "", { timeout: 15_000 })
    .toContain("blocks");
});
