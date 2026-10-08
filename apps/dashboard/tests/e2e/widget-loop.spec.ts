import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { psql } from "./helpers/mint";
import { SLUG, launcher, openPanel, startWidgetHost, widgetCustomer } from "./helpers/widget-host";

// The customer's side of the loop, through the real widget embedded in a host
// page on its own origin and signed in with minted identity tokens (the HS256
// the Install page tells hosts to sign). The vendor is the seeded admin in the
// dashboard. Each test's customer is new, so their list is only what it made.

test.use({ storageState: { cookies: [], origins: [] }, locale: "en-GB" }); // the customer: no dashboard session

const ADMIN = resolve(__dirname, ".auth/admin.json"); // the seeded admin's session (setup.ts)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let host: Awaited<ReturnType<typeof startWidgetHost>>;
test.beforeAll(async ({ baseURL }) => { host = await startWidgetHost(baseURL!); });
test.afterAll(async () => { await host.close(); });

// The seeded admin, in the dashboard, on one thread.
async function vendorThread(browser: Browser, baseURL: string | undefined, shortId: string) {
  const ctx = await browser.newContext({ baseURL, storageState: ADMIN });
  const v = await ctx.newPage();
  // Dev compiles /thread/[shortId] on its first visit; that can take a while.
  await v.goto(`/thread/${shortId}`, { timeout: 90_000 });
  await expect(v.locator("body")).toContainText(shortId, { timeout: 60_000 });
  return { v, close: () => ctx.close() };
}

async function vendorSend(v: Page, body: string, button: RegExp) {
  const composer = v.getByPlaceholder(/reply|message|type/i).first();
  await composer.fill(body);
  await v.getByRole("button", { name: button }).click();
  await expect(composer).toHaveValue("", { timeout: 15_000 }); // cleared once it landed
}

// The list loaded (the row is there): what it says, and what the launcher says.
async function news(page: Page, dialog: Locator, shortId: string, row: RegExp | string, tab: string) {
  const r = dialog.locator(`[data-short="${shortId}"]`);
  await expect(r).toBeVisible();
  await (typeof row === "string" ? expect(r).toContainText(row) : expect(r).not.toContainText(row));
  await expect(launcher(page)).toHaveAccessibleName(tab);
}

test("a submission carries where it came from into the vendor's Details", async ({ page, browser, baseURL }) => {
  const c = widgetCustomer("Maya Lin");
  await page.goto(host.url("/reports/42", { "user-jwt": c.jwt, "app-version": "4.2.1" }), { referer: "http://news.example/launch" });

  const dialog = await openPanel(page);
  await dialog.getByRole("button", { name: "Share feedback" }).first().click();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Export is empty");
  await dialog.getByRole("textbox", { name: /^Details/ }).fill("The CSV has headers only.");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Feedback sent" })).toBeVisible();
  const shortId = (await dialog.locator(".short-id").innerText()).trim();
  expect(shortId).toMatch(/^FB-\d+$/);

  const { v, close } = await vendorThread(browser, baseURL, shortId);
  const from = v.locator(".card", { hasText: "Submitted from" });
  // The page, as a link, without the token that was in its query.
  const pageLink = from.getByRole("link", { name: `${new URL(host.origin).host}/reports/42` });
  await expect(pageLink).toHaveAttribute("href", `${host.origin}/reports/42?user-jwt=[redacted]&app-version=4.2.1`);
  await expect(from).toContainText("Acme Reports");
  // One device line: browser, OS, viewport, the customer's locale, the host's build.
  await expect(from).toContainText(/Chrome \d+ · [^·]+ · 1280×720 · en-GB · App 4\.2\.1/);
  await expect(from).toContainText("Came from news.example");
  await close();
});

test("compose files ride on the first message, with no empty reply, and open through their signed link", async ({ page, context }) => {
  const c = widgetCustomer("Theo Park");
  await page.goto(host.url("/billing", { "user-jwt": c.jwt }));

  const dialog = await openPanel(page);
  await dialog.getByRole("button", { name: "Share feedback" }).first().click();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Invoice total is off");
  await dialog.getByRole("textbox", { name: /^Details/ }).fill("Screenshot attached.");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles({ name: "invoice.png", mimeType: "image/png", buffer: PNG });
  await expect(dialog.getByRole("button", { name: "Remove invoice.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Feedback sent" })).toBeVisible();
  const shortId = (await dialog.locator(".short-id").innerText()).trim();

  // One message: the customer's words with the file on it. No second, empty
  // "customer replied" message (the old two-request send) behind it.
  const messages = psql(
    `SELECT r.body, (SELECT string_agg(a.filename, ',') FROM attachments a WHERE a.reply_id = r.id)
     FROM replies r JOIN items i ON i.id = r.item_id JOIN workspaces w ON w.id = i.workspace_id
     WHERE w.slug = '${SLUG}' AND i.short_id = '${shortId}'`,
  ).split("\n");
  expect(messages).toEqual(["Screenshot attached.|invoice.png"]);

  // In the thread the file opens in a new tab through its signed link: this
  // browser has no Crumb cookie, and a new tab can't carry the widget's token.
  await dialog.getByRole("button", { name: "See your feedback" }).click();
  await dialog.locator(`[data-short="${shortId}"]`).click();
  const file = dialog.getByRole("link", { name: /invoice\.png/ });
  await expect(file).toHaveAttribute("href", /\/api\/v1\/uploads\/[\w-]+\?exp=\d+&sig=[\w-]{22}$/);
  const [tab] = await Promise.all([context.waitForEvent("page"), file.click()]);
  await tab.waitForLoadState();
  expect(await tab.evaluate(() => document.contentType)).toBe("image/png");
  expect(await tab.evaluate(() => document.images[0]?.naturalWidth)).toBe(1);
});

test("a vendor reply lights the row and the launcher; the customer's own messages never do", async ({ page, request, browser, baseURL }) => {
  const c = widgetCustomer("Ines Cole");
  const created = await request.post("/api/v1/items", {
    headers: c.headers,
    data: { type: "idea", title: "Dark mode for reports", body: "Our team works late." },
  });
  expect(created.status()).toBe(201);
  const shortId = (await created.json()).short_id as string;

  // Their own request isn't news, and neither is their own reply.
  await page.goto(host.url("/app", { "user-jwt": c.jwt }));
  let dialog = await openPanel(page);
  await news(page, dialog, shortId, /New reply/, "Feedback");
  await dialog.locator(`[data-short="${shortId}"]`).click();
  await dialog.getByRole("textbox", { name: "Your reply" }).fill("Even a dim theme would help.");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByText("Even a dim theme would help.")).toBeVisible();
  await page.reload();
  dialog = await openPanel(page);
  await news(page, dialog, shortId, /New reply/, "Feedback");

  // The vendor answers from the dashboard.
  const { v, close } = await vendorThread(browser, baseURL, shortId);
  await vendorSend(v, "Dark mode is planned for the next release.", /^Send (to |reply)/i);
  await close();

  // Next page load: the launcher says so before it's opened, and the row is marked.
  await page.reload();
  await expect(launcher(page)).toHaveAccessibleName("Feedback, 1 update");
  dialog = await openPanel(page);
  await news(page, dialog, shortId, "New reply", "Feedback, 1 update");

  // Reading it clears it, for good.
  await dialog.locator(`[data-short="${shortId}"]`).click();
  await expect(dialog.getByText("Dark mode is planned for the next release.")).toBeVisible();
  await dialog.getByRole("button", { name: "Back" }).click();
  await news(page, dialog, shortId, /New reply/, "Feedback");
  await page.reload();
  dialog = await openPanel(page);
  await news(page, dialog, shortId, /New reply/, "Feedback");
});

test("after the update, a returning customer's replies so far stay read; a new customer's are news", async ({ page, request }) => {
  const withVendorReply = async (who: ReturnType<typeof widgetCustomer>) => {
    const res = await request.post("/api/v1/items", { headers: who.headers, data: { type: "bug", title: "Login loops", body: "Twice today." } });
    const shortId = (await res.json()).short_id as string;
    psql(
      `INSERT INTO replies (item_id, workspace_user_id, body, internal)
       SELECT i.id, wu.id, 'We shipped a fix.', false
       FROM items i JOIN workspaces w ON w.id = i.workspace_id
       JOIN workspace_users wu ON wu.workspace_id = w.id AND wu.email = 'lina@southbeam.io'
       WHERE w.slug = '${SLUG}' AND i.short_id = '${shortId}'`,
    );
    return shortId;
  };

  // Returning: the widget before this one left its every-message map here.
  const returning = widgetCustomer("Ravi Shah");
  const shortId = await withVendorReply(returning);
  await page.goto(host.url("/app"));
  await page.evaluate((k) => localStorage.setItem(k, "{}"), `crumb_seen:${SLUG}:jwt`);
  await page.goto(host.url("/app", { "user-jwt": returning.jwt }));
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), `crumb_seen_vendor:${SLUG}:${returning.email}`))
    .toBe(JSON.stringify({ [shortId]: 1 }));
  await expect(launcher(page)).toHaveAccessibleName("Feedback");
  expect(await page.evaluate((k) => localStorage.getItem(k), `crumb_seen:${SLUG}:jwt`)).toBeNull(); // carried over once

  // New: nothing to carry over, so the vendor's reply is news.
  const fresh = widgetCustomer("Noor Haddad");
  await withVendorReply(fresh);
  await page.goto(host.url("/app", { "user-jwt": fresh.jwt }));
  await expect(launcher(page)).toHaveAccessibleName("Feedback, 1 update");
});

test("a declined request shows its reason at the top of the thread, at the default size", async ({ page, request, browser, baseURL }) => {
  const c = widgetCustomer("Lea Brun");
  const created = await request.post("/api/v1/items", {
    headers: c.headers,
    data: { type: "idea", title: "Export to XML", body: "Our ERP wants XML." },
  });
  const shortId = (await created.json()).short_id as string;

  // The vendor declines from the dashboard; the reply is the reason.
  const reason = "Not planned: CSV and the API cover exports, and XML would split our upkeep.";
  const { v, close } = await vendorThread(browser, baseURL, shortId);
  await vendorSend(v, reason, /^Send and mark Won.t ship$/);
  await close();

  await page.goto(host.url("/app", { "user-jwt": c.jwt }));
  const dialog = await openPanel(page);
  await dialog.locator(`[data-short="${shortId}"]`).click();
  const note = dialog.locator(".status-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(`Won’t ship. ${reason}`);
  // Not expanded: the status rail (the other place a reason shows) is hidden,
  // and the note sits above the conversation.
  await expect(dialog.getByRole("button", { name: "Expand" })).toBeVisible();
  await expect(dialog.locator(".status-rail")).toBeHidden();
  const [noteBox, firstMessage] = await Promise.all([note.boundingBox(), dialog.locator(".msg").first().boundingBox()]);
  expect(noteBox!.y).toBeLessThan(firstMessage!.y);
});

test("identify() switches the customer in place, and shutdown() signs them out", async ({ page, request }) => {
  const a = widgetCustomer("Ana Ruiz");
  const b = widgetCustomer("Ben Okafor");
  for (const [who, title] of [[a, "Ana's request"], [b, "Ben's request"]] as const) {
    const res = await request.post("/api/v1/items", { headers: who.headers, data: { type: "question", title, body: "?" } });
    expect(res.status()).toBe(201);
  }

  // The tag loads before anyone signs in: no launcher yet.
  await page.goto(host.url("/app"));
  await page.waitForFunction(() => window.crumb?.__mounted === true);
  await expect(launcher(page)).toBeHidden();

  await page.evaluate((jwt) => window.crumb!.identify({ jwt }), a.jwt);
  let dialog = await openPanel(page);
  await expect(dialog).toContainText("Ana Ruiz Co");
  await expect(dialog).toContainText("Ana's request");
  await page.keyboard.press("Escape");

  await page.evaluate((jwt) => window.crumb!.identify({ jwt }), b.jwt);
  dialog = await openPanel(page);
  await expect(dialog).toContainText("Ben Okafor Co");
  await expect(dialog).toContainText("Ben's request");
  await expect(dialog).not.toContainText("Ana");
  await page.keyboard.press("Escape");

  // Each customer's status marks are their own, never one shared "jwt" map.
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("crumb_status_seen:")).sort());
  expect(keys).toEqual([`crumb_status_seen:${SLUG}:${a.email}`, `crumb_status_seen:${SLUG}:${b.email}`].sort());

  await page.evaluate(() => window.crumb!.shutdown());
  await expect(launcher(page)).toBeHidden();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator("#crumb-widget")).not.toContainText("Ben");
});

test("an expired token shows the plain error with Try again, and the draft survives the new token", async ({ page, request }) => {
  const c = widgetCustomer("Omar Aziz");
  const created = await request.post("/api/v1/items", { headers: c.headers, data: { type: "bug", title: "Search ignores accents", body: "café vs cafe" } });
  const shortId = (await created.json()).short_id as string;

  // Halfway through a reply on a live token.
  await page.goto(host.url("/app", { "user-jwt": c.jwt }));
  const dialog = await openPanel(page);
  await dialog.locator(`[data-short="${shortId}"]`).click();
  await dialog.getByRole("textbox", { name: "Your reply" }).fill("Half a thought about accents");

  // Back later: the page renders with a token that has since expired.
  const now = Math.floor(Date.now() / 1000);
  await page.goto(host.url("/app", { "user-jwt": c.token({ iat: now - 7200, exp: now - 3600 }) }));
  await page.waitForFunction(() => window.crumb?.__mounted === true);
  await page.evaluate(() => {
    const w = window as unknown as { expiredCalls: number };
    w.expiredCalls = 0;
    window.crumb!.onTokenExpired(() => { w.expiredCalls++; });
  });
  await page.evaluate((sid) => window.crumb!.open(sid), shortId);
  await expect(dialog).toContainText("Your session expired. Reload the page to continue.");
  await expect(dialog).not.toContainText(/jwt|_expired|401/);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toContainText("Your session expired. Reload the page to continue.");
  await expect(dialog.getByRole("textbox", { name: "Your reply" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { expiredCalls: number }).expiredCalls)).toBe(1);

  // The host hands over a fresh token: the thread loads with the draft intact.
  await page.evaluate((jwt) => window.crumb!.identify({ jwt }), c.token({ iat: now, exp: now + 3600 }));
  await expect(dialog.getByRole("textbox", { name: "Your reply" })).toHaveValue("Half a thought about accents");
});

test("crumb.track() sends the page it fired on without the page's secrets", async ({ page }) => {
  const c = widgetCustomer("Kai Moen");
  const name = `e2e.signed_in.${Date.now()}`;
  const redacted = `${host.origin}/auth/callback?code=[redacted]&state=ok&user-jwt=[redacted]`;
  await page.goto(host.url("/auth/callback", { code: "oauth-secret-123", state: "ok", "user-jwt": c.jwt }));
  await page.waitForFunction(() => window.crumb?.__mounted === true);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/v1/usage-events") && r.method() === "POST", { timeout: 20_000 });
  await page.evaluate((n) => window.crumb!.track(n, { plan: "team" }), name);
  const body = (await sent).postDataJSON() as { events: Array<{ name: string; page_url: string }> };
  expect(body.events.find((e) => e.name === name)?.page_url).toBe(redacted);
  await expect.poll(() => psql(`SELECT page_url FROM usage_events WHERE name = '${name}'`)).toBe(redacted);
});
