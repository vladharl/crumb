import { test, expect, type Page } from "@playwright/test";
import { launcher, openPanel, startWidgetHost, widgetCustomer } from "./helpers/widget-host";

// The widget for keyboard and screen-reader customers, in a real browser: the
// panel is a modal dialog that holds focus while open and hands it back when
// it closes, controls keep their names mid-send, focus lands somewhere sane
// after a removal, and on a phone the panel is a full-screen sheet. Signed in
// with minted tokens on a host page of its own origin.

test.use({ storageState: { cookies: [], origins: [] } }); // the customer: no dashboard session

let host: Awaited<ReturnType<typeof startWidgetHost>>;
test.beforeAll(async ({ baseURL }) => { host = await startWidgetHost(baseURL!); });
test.afterAll(async () => { await host.close(); });

const bodyHasFocus = (page: Page) => page.evaluate(() => document.activeElement === document.body);

test("the panel is a modal dialog: focus goes in on open, Tab stays inside, Escape hands it back", async ({ page, request }) => {
  const c = widgetCustomer("Mia Stone");
  expect((await request.post("/api/v1/items", { headers: c.headers, data: { type: "idea", title: "Keyboard shortcuts", body: "j/k to move." } })).status()).toBe(201);
  await page.goto(host.url("/app", { "user-jwt": c.jwt }));
  await expect(launcher(page)).toBeVisible();

  // crumb.close() on a closed panel moves nobody's focus: not from a host
  // field, and not from the page itself.
  await page.locator("#host-search").focus();
  await page.evaluate(() => window.crumb!.close());
  await expect(page.locator("#host-search")).toBeFocused();
  await page.locator("#host-search").blur();
  expect(await bodyHasFocus(page)).toBe(true);
  await page.evaluate(() => window.crumb!.close());
  expect(await bodyHasFocus(page)).toBe(true);

  // Opened from the launcher by keyboard: a named modal dialog, focus inside.
  await launcher(page).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Your feedback" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator(":focus")).toHaveCount(1);

  // Tab and Shift+Tab go round inside it, past either end.
  for (const key of [...Array(10).fill("Tab"), ...Array(10).fill("Shift+Tab")]) {
    await page.keyboard.press(key);
    await expect(dialog.locator(":focus")).toHaveCount(1);
  }

  // Escape closes it and focus goes back to the launcher that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launcher(page)).toBeFocused();
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "false");

  // Opened from the host's own button, it goes back there.
  await page.getByRole("button", { name: "Give feedback" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#host-feedback")).toBeFocused();

  // And closing it again, already closed, leaves focus where it is.
  await page.evaluate(() => window.crumb!.close());
  await expect(page.locator("#host-feedback")).toBeFocused();
});

test("the reply button keeps a name while it sends", async ({ page, request }) => {
  const c = widgetCustomer("Sol Reyes");
  const created = await request.post("/api/v1/items", { headers: c.headers, data: { type: "question", title: "SSO for contractors?", body: "Okta." } });
  const shortId = (await created.json()).short_id as string;
  await page.goto(host.url("/app", { "user-jwt": c.jwt }));
  const dialog = await openPanel(page);
  await dialog.locator(`[data-short="${shortId}"]`).click();

  // Hold the reply in flight long enough to look at the button.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route(`**/api/v1/items/${shortId}`, async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  await dialog.getByRole("textbox", { name: "Your reply" }).fill("Okta, yes.");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sending…" })).toBeDisabled();
  release();
  await expect(dialog.getByText("Okta, yes.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("removing a teammate moves focus to the next row, then to the list's heading", async ({ page, request }) => {
  const account = `Focus Co ${Date.now()}`;
  const ada = widgetCustomer("Ada Admin", { account_name: account, role: "admin" });
  for (const name of ["Bo Teammate", "Cy Teammate"]) {
    const mate = widgetCustomer(name, { account_name: account, role: "member" });
    expect((await request.get("/api/v1/me", { headers: mate.headers })).ok()).toBe(true); // signs them up
  }
  await page.goto(host.url("/app", { "user-jwt": ada.jwt }));
  const dialog = await openPanel(page);
  await dialog.getByRole("tab", { name: "Admin" }).click();
  await expect(dialog.getByRole("textbox", { name: "Slack webhook URL" })).toBeVisible(); // channels loaded

  // Bo's row goes; focus moves on to Cy's Remove, not up to the tabs.
  await dialog.getByRole("button", { name: "Remove Bo Teammate" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).not.toContainText("Bo Teammate");
  await expect(dialog.getByRole("button", { name: "Remove Cy Teammate" })).toBeFocused();

  // The last removable row goes: focus lands on the list's heading, and Tab
  // carries on from there.
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).not.toContainText("Cy Teammate");
  await expect(dialog.locator("#crumb-members-head")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("textbox", { name: "Slack webhook URL" })).toBeFocused();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the panel is a full-screen sheet", async ({ page }) => {
    const c = widgetCustomer("Ivy Tran");
    await page.goto(host.url("/app", { "user-jwt": c.jwt }));
    const dialog = await openPanel(page);
    await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 375, height: 812 });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  });
});
