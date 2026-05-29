import { test, expect } from "@playwright/test";

// Self-host trusted-email path — the bundled /widget-demo.html submits via
// data-* attributes (no JWT). On Cloud this would 401 via lib/public-api;
// the test relies on the dev server running with CRUMB_TIER unset (i.e.
// self_host default).
test.use({ storageState: { cookies: [], origins: [] } }); // unauthenticated for the customer side

test("widget submit creates a new item via /api/v1/items", async ({ page, request }) => {
  // Direct POST (the widget UI is shadow-DOM heavy; for a stable e2e the
  // round-trip via the public API is what we lock in).
  const title = `e2e widget item ${Date.now()}`;
  const resp = await request.post("/api/v1/items", {
    headers: { "content-type": "application/json" },
    data: {
      workspace_slug: "northbeam",
      account_user_email: `e2e+${Date.now()}@example.com`,
      account_user_name: "E2E Tester",
      account_name: "E2E Co",
      type: "bug",
      title,
      body: "submitted from playwright",
    },
  });
  expect(resp.status()).toBe(201);
  const json = await resp.json();
  expect(json.short_id).toMatch(/^FB-\d+$/);

  // Spot-check the widget-demo page loads (the launcher SVG is in the
  // server-rendered HTML).
  await page.goto("/widget-demo.html");
  await expect(page.locator("body")).toContainText(/widget|demo/i, { timeout: 5000 });

  // Optional follow-on: the submitted item appears in the vendor inbox
  // for a signed-in admin. We don't sign in here (this spec uses an empty
  // storageState for the customer side); the new-item-shows-in-inbox
  // assertion is covered indirectly by inbox-renders.spec.ts after a
  // seed re-run.
});
