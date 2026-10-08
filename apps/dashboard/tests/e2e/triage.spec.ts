import { test, expect, type Page } from "@playwright/test";
import { psql } from "./helpers/mint";

// Batch 7's triage tools in a real browser, as the seeded admin: Compose from
// a link (?compose=1), Cmd/Ctrl+K search that opens an item, keyboard triage
// on the inbox, and Delete with Undo from the thread.

const SLUG = "southbeam";

const itemExists = (title: string) =>
  psql(`SELECT count(*) FROM items i JOIN workspaces w ON w.id = i.workspace_id WHERE w.slug = '${SLUG}' AND i.title = '${title}'`) === "1";

async function composeItem(page: Page, title: string): Promise<string> {
  await page.goto("/inbox?compose=1");
  const panel = page.getByRole("dialog", { name: "Compose on behalf" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.getByPlaceholder("Acme Co").fill("Triage Test Co");
  await panel.getByPlaceholder("maya@acme.co").fill(`triage+${Date.now()}@example.com`);
  await panel.getByPlaceholder("One line: what's the gist?").fill(title);
  await panel.getByRole("button", { name: "Create request" }).click();
  await page.waitForURL(/\/thread\/FB-\d+$/, { timeout: 30_000 });
  return page.url().split("/thread/")[1]!;
}

test("Cmd/Ctrl+K finds an item by its title and opens it", async ({ page }) => {
  const title = `Palette finds this ${Date.now()}`;
  const shortId = await composeItem(page, title);

  await page.goto("/inbox");
  await expect(page.locator("text=/FB-\\d+/").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").or(palette.getByRole("textbox")).first().fill(title.split(" ").slice(0, 3).join(" ") + " " + title.split(" ").pop());
  await expect(palette.getByRole("option", { name: new RegExp(title) })).toBeVisible({ timeout: 10_000 });
  await palette.getByRole("option", { name: new RegExp(title) }).click();
  await page.waitForURL(new RegExp(`/thread/${shortId}$`));
});

test("the inbox answers to j, ?, Escape and Enter, and arrows still scroll from outside the rows", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.locator("text=/FB-\\d+/").first()).toBeVisible({ timeout: 15_000 });

  // Arrows away from the rows leave the page alone (no row takes focus).
  await page.locator("body").press("ArrowDown");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".inbox-row"))).toBe(false);

  await page.keyboard.press("j");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".inbox-row"))).toBe(true);

  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Focus can fall out of a dialog (a button disabling itself drops it to
  // <body>); Escape still closes it, and the page isn't left inert.
  await page.keyboard.press("?");
  await expect(sheet).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => !!document.querySelector("main")?.closest("[inert]"))).toBe(false);

  await page.keyboard.press("Enter");
  await page.waitForURL(/\/thread\/FB-\d+$/, { timeout: 30_000 });
});

test("Delete waits behind Undo: Undo keeps the item, letting it run removes it", async ({ page }) => {
  const title = `Delete me ${Date.now()}`;
  await composeItem(page, title);
  expect(itemExists(title)).toBe(true);

  // Undo inside the window: nothing is deleted.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone. Nothing was deleted.")).toBeVisible();
  expect(itemExists(title)).toBe(true);

  // Let the window run out: the item is gone and the admin lands on the inbox.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForURL(/\/inbox$/, { timeout: 20_000 });
  await expect.poll(() => itemExists(title), { timeout: 10_000 }).toBe(false);
});
