import { test, expect } from "@playwright/test";
import { mintWidgetJwt, stdoutEmails } from "./helpers/mint";

test("opening a thread and posting a vendor reply adds a new message", async ({ page }) => {
  await page.goto("/inbox");

  // Wait for the table tile to resolve, then click the first FB-N link.
  const firstRowId = page.locator("text=/FB-\\d+/").first();
  await expect(firstRowId).toBeVisible({ timeout: 10_000 });
  const shortId = (await firstRowId.innerText()).trim();
  // The row's title link covers the row, so click it rather than the id cell.
  await page.locator(`a.row-link[href="/thread/${shortId}"]`).first().click();

  // Land on /thread/{shortId}. The crumb shows the same id. The generous
  // timeout absorbs Next dev's cold first-compile of the /thread/[shortId]
  // route, which can take tens of seconds on a slow box (irrelevant in a
  // prebuilt/CI run, but this keeps the test from flaking locally).
  await expect(page).toHaveURL(new RegExp(`/thread/${shortId}$`), { timeout: 60_000 });
  await expect(page.locator("body")).toContainText(shortId, { timeout: 10_000 });

  // Compose a reply. The composer textarea + send button live in the
  // ThreadView client component. The button names who it reaches ("Send to
  // Maya", or "Send reply" when nobody gets emailed); the pattern skips the
  // "Send and mark …" buttons beside it.
  const composer = page.getByPlaceholder(/reply|message|type/i).first();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  const replyBody = `e2e reply ${Date.now()}`;
  await composer.fill(replyBody);

  await page.getByRole("button", { name: /^Send (to |reply)/i }).click();

  // The new reply appears in the customer-tab view (default tab). Allow
  // headroom for the server action round-trip + revalidation.
  await expect(page.locator("body")).toContainText(replyBody, { timeout: 15_000 });
});

// Switching the thread to its Internal tab turns the composer into an internal
// note, so what a teammate types there stays with the team. The customer is a
// real identified widget user (a minted JWT), whose own view of the thread is
// the widget API.
test("a note written on the Internal tab never reaches the customer", async ({ page, request }) => {
  const tag = Date.now();
  const customer = {
    authorization: `Bearer ${mintWidgetJwt("southbeam", { sub: `nora+${tag}@example.com`, name: "Nora Quinn", account_name: "E2E Notes Co" })}`,
  };
  const filed = await request.post("/api/v1/items", {
    headers: customer,
    data: { type: "idea", title: `Dark mode ${tag}`, body: "Please add a dark theme." },
  });
  expect(filed.status()).toBe(201);
  const shortId = (await filed.json()).short_id as string;

  await page.goto(`/thread/${shortId}`);
  const internalTab = page.getByRole("button", { name: /^Internal · / });
  await internalTab.waitFor({ timeout: 60_000 }); // Next dev's first compile of the thread route
  await expect(page.getByRole("tab", { name: "Reply" })).toHaveAttribute("aria-selected", "true");

  await internalTab.click();
  await expect(page.getByRole("tab", { name: "Internal note" })).toHaveAttribute("aria-selected", "true");
  const note = `churn risk, keep this internal ${tag}`;
  await page.getByRole("textbox", { name: "Internal note" }).fill(note);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByText("Note added. Only your team can see it.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).toContainText(note);

  // Back on Customer the composer replies again, and the note isn't there.
  await page.getByRole("button", { name: /^Customer · / }).click();
  await expect(page.getByRole("tab", { name: "Reply" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /^Send (to |reply)/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(note);

  // The customer's own view of the thread never has it, and no email carried it.
  const thread = await request.get(`/api/v1/items/${shortId}`, { headers: customer });
  expect(thread.ok()).toBeTruthy();
  const messages = (await thread.json()).messages as Array<{ body: string }>;
  expect(messages.map((m) => m.body)).toEqual(["Please add a dark theme."]);
  expect((stdoutEmails() ?? []).filter((e) => Object.values(e).some((v) => v?.includes(note)))).toEqual([]);
});
