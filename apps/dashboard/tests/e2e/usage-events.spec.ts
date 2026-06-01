import { test, expect } from "@playwright/test";

// Usage-analytics round-trip: crumb.track() → /api/v1/usage-events → the
// account surface. Mirrors widget-submit.spec.ts: the public POST uses the
// self-host trusted-email path (no JWT); then a signed-in admin sees the new
// account with a populated "Active" column.
//
// On self-host, usage ingestion is capability-gated (allowed); the AI
// usage-query path is the only Cloud-only piece, so this works on the
// self_host dev server the suite runs against.

test("usage events ingest and surface on the accounts list", async ({ page, request }) => {
  const stamp = Date.now();
  const accountName = `Usage E2E ${stamp}`;

  // Customer-side batch POST. resolveCustomer upserts the account + user from
  // the trusted-email fallback, so this also creates the account we then look
  // for in the vendor dashboard.
  const resp = await request.post("/api/v1/usage-events", {
    headers: { "content-type": "application/json" },
    data: {
      workspace_slug: "southbeam",
      account_user_email: `usage+${stamp}@example.com`,
      account_user_name: "Usage Tester",
      account_name: accountName,
      events: [
        { name: "export.csv" },
        { name: "dashboard.viewed", props: { tab: "cohorts" } },
        { name: "export.csv" },
      ],
    },
  });
  expect(resp.status()).toBe(202);
  const json = await resp.json();
  expect(json.accepted).toBe(3);

  // A bad batch (empty) is rejected by the schema.
  const bad = await request.post("/api/v1/usage-events", {
    headers: { "content-type": "application/json" },
    data: { workspace_slug: "southbeam", account_user_email: `usage+${stamp}@example.com`, account_name: accountName, events: [] },
  });
  expect(bad.status()).toBe(400);

  // Vendor side (signed-in admin via the default storageState): the accounts
  // list now shows the new account, and the "Active" column appears because at
  // least one account has usage activity.
  await page.goto("/accounts");
  await expect(page.locator(".list-row.head")).toContainText("Active");
  await expect(page.locator(".list")).toContainText(accountName);
});
