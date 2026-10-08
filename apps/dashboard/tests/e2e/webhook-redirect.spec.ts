import { test, expect } from "@playwright/test";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { psql } from "./helpers/mint";

// Outbound webhooks don't follow redirects (lib/webhooks.ts deliverOne): the
// SSRF guard vetted the endpoint's URL, not wherever a 30x points (e.g.
// 169.254.169.254). An in-process endpoint answers the delivery with a 302 to a
// second in-process server, which must never be hit, and the endpoint records
// the 302 as a failed delivery. Self-host tier (playwright.config.ts) lets the
// guard allow localhost.

const endpointHits: string[] = [];
const targetHits: string[] = [];
let endpoint: Server;
let target: Server;
let hookUrl: string;

async function listen(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  return server;
}

const port = (s: Server) => (s.address() as AddressInfo).port;

test.beforeAll(async () => {
  target = await listen((req, res) => {
    targetHits.push(`${req.method} ${req.url}`);
    res.end("ok");
  });
  endpoint = await listen((req, res) => {
    endpointHits.push(String(req.headers["x-crumb-event"]));
    req.resume();
    res.writeHead(302, { location: `http://localhost:${port(target)}/landed` }).end();
  });
  hookUrl = `http://localhost:${port(endpoint)}/hook`;
});

test.afterAll(async () => {
  psql(`DELETE FROM webhook_endpoints WHERE url = '${hookUrl}'`);
  await Promise.all([endpoint, target].map((s) => new Promise((r) => s.close(r))));
});

test("a delivery answered with a redirect isn't followed and counts as failed", async ({ page }) => {
  await page.goto("/settings/webhooks");
  await page.getByPlaceholder(/your-app\.example\.com/i).fill(hookUrl);
  await page.getByRole("button", { name: /Add endpoint/i }).click();
  await expect(page.getByText(/Save this signing secret/i)).toBeVisible({ timeout: 10_000 });

  // Change the first inbox row's status from the row menu: In review, or Open
  // when it already is. Neither asks for a reason or a confirmation.
  await page.goto("/inbox");
  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  await page.locator(".list-row", { hasText: shortId }).getByRole("button", { name: `Actions for ${shortId}` }).click();
  const menu = page.getByRole("menu");
  await menu.getByText("Set status…").click();
  const inReview = menu.getByRole("button", { name: "In review", exact: true });
  const next = (await inReview.locator(".dd-tick").count()) ? menu.getByRole("button", { name: "Open", exact: true }) : inReview;
  await next.click();

  await expect.poll(() => endpointHits, { timeout: 15_000 }).toContain("item.status_changed");

  const row = page.locator("div.col", { has: page.getByText(hookUrl, { exact: true }) }).last();
  await expect(async () => {
    await page.goto("/settings/webhooks");
    await expect(row).toContainText(/\d+ failed events? in a row\./, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await row.getByText(/Recent deliveries/).click();
  await expect(row.locator("tr", { hasText: "302" }).first()).toContainText("Answered with a redirect, which is not followed");
  expect(targetHits).toEqual([]);
});
