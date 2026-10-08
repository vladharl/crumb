import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { psql, stdoutEmails, workspaceSigningSecret } from "./helpers/mint";

// Batch 9's public pages, as an anonymous visitor (no session): off until the
// workspace opts in, public initiatives by lane with nothing about customers,
// and a double opt-in follow that confirms by emailed link and unsubscribes in
// one click (the confirmation is read from the stdout provider's output; the
// unsubscribe link is minted the way update emails sign it).

test.use({ storageState: { cookies: [], origins: [] } });

const SLUG = "southbeam";
const tag = Date.now();
const NAME = `Offline mode ${tag}`;
let initiativeId = "";

const setPages = (on: boolean) => psql(`UPDATE workspaces SET public_pages_enabled = ${on} WHERE slug = '${SLUG}'`);

test.beforeAll(() => {
  // A public initiative in Now, numbered clear of anything the seed or the app hands out.
  const seq = 900_000 + (tag % 99_999);
  initiativeId = psql(
    `INSERT INTO initiatives (workspace_id, seq, short_id, name, description, is_public, roadmap_column)
     SELECT id, ${seq}, 'IN-${seq}', '${NAME}', 'Work without a connection.', true, 'now' FROM workspaces WHERE slug = '${SLUG}'
     RETURNING id`,
  );
});

test.afterAll(() => {
  psql(`DELETE FROM initiatives WHERE id = '${initiativeId}'`);
  setPages(false);
});

test("the public pages stay off until the workspace turns them on", async ({ page }) => {
  setPages(false);
  expect((await page.goto(`/${SLUG}/roadmap`))?.status()).toBe(404);
  expect((await page.goto(`/${SLUG}/changelog`))?.status()).toBe(404);
});

test("the roadmap shows public initiatives by lane, and nothing about customers", async ({ page }) => {
  setPages(true);
  await page.goto(`/${SLUG}/roadmap`);
  await expect(page.getByRole("region", { name: "Now" })).toContainText(NAME);
  await expect(page.getByRole("region", { name: "Shipped" })).toBeVisible();

  const html = await page.content();
  const accounts = psql(`SELECT a.name FROM accounts a JOIN workspaces w ON w.id = a.workspace_id WHERE w.slug = '${SLUG}'`)
    .split("\n").filter((n) => n.length >= 5);
  expect(accounts.length).toBeGreaterThan(0);
  for (const name of accounts) expect(html, `account "${name}" on the public roadmap`).not.toContain(name);
  expect(html).not.toMatch(/\bARR\b/);

  await page.goto(`/${SLUG}/changelog`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a visitor follows by email, confirms from the emailed link, and unsubscribes in one click", async ({ page }) => {
  setPages(true);
  const email = `follower+${tag}@example.com`;
  await page.goto(`/${SLUG}/roadmap`);
  const card = page.locator("article", { hasText: NAME });
  await card.locator("summary", { hasText: "Follow" }).click();
  await card.getByPlaceholder("you@company.com").fill(email);
  await card.getByRole("button", { name: "Follow" }).click();
  await expect(card.getByRole("status")).toHaveText("Check your inbox to confirm.");

  // Nothing is followed until the link is used, and the GET only asks.
  const confirmMail = () => (stdoutEmails() ?? []).filter((m) => m.to === email && /^Confirm updates/.test(m.subject ?? "")).pop();
  await expect.poll(() => confirmMail()?.link ?? "", { timeout: 15_000 }).toMatch(new RegExp(`/${SLUG}/confirm\\?t=`));
  const link = confirmMail()!.link!;
  await page.goto(link);
  expect(psql(`SELECT confirmed_at IS NULL FROM public_follows WHERE email = '${email}'`)).toBe("t");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("heading", { name: "You’re following" })).toBeVisible();
  expect(psql(`SELECT confirmed_at IS NOT NULL FROM public_follows WHERE email = '${email}'`)).toBe("t");

  // Following again says the same thing, whether or not the address follows.
  await page.goto(`/${SLUG}/roadmap`);
  await card.locator("summary", { hasText: "Follow" }).click();
  await card.getByPlaceholder("you@company.com").fill(email);
  await card.getByRole("button", { name: "Follow" }).click();
  await expect(card.getByRole("status")).toHaveText("Check your inbox to confirm.");

  // The unsubscribe link every update email carries: an HMAC over the follow id.
  const followId = psql(`SELECT id FROM public_follows WHERE email = '${email}'`);
  const sig = createHmac("sha256", workspaceSigningSecret(SLUG)).update(`public-unsub:${followId}`).digest().subarray(0, 16).toString("base64url");
  await page.goto(`/${SLUG}/unsubscribe?f=${followId}&s=${sig}`);
  expect(psql(`SELECT unsubscribed_at IS NULL FROM public_follows WHERE id = '${followId}'`)).toBe("t");
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByRole("heading", { name: "You’re unsubscribed" })).toBeVisible();
  expect(psql(`SELECT unsubscribed_at IS NOT NULL FROM public_follows WHERE id = '${followId}'`)).toBe("t");

  // A forged signature is refused.
  const bad = await page.goto(`/${SLUG}/unsubscribe?f=${followId}&s=AAAAAAAAAAAAAAAAAAAAAA`);
  expect(bad?.status()).toBeGreaterThanOrEqual(400);
});
