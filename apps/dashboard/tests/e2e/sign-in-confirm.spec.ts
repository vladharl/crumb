import { test, expect } from "@playwright/test";
import { mintMagicLink, psql, publicOrigin } from "./helpers/mint";

// Opening an emailed sign-in link signs no one in: GET /login/verify forwards to
// the Continue page, so a mail scanner that fetches every link can't burn it,
// and only the Continue button's POST spends the token (app/login/verify). The
// link's `next` survives the hop, kept on this origin by safeNextPath
// (lib/auth.ts) on the page and again on the POST. Links minted for the seeded
// admin, opened in a signed-out browser.

test.use({ storageState: { cookies: [], origins: [] } });

const EMAIL = "lina@southbeam.io";
const CONTINUE = { name: "Continue to Crumb" };

// "t" once the link's token is spent (magic_tokens.consumed_at), "f" before.
function spent(link: string): string {
  const token = new URLSearchParams(link.split("?")[1]).get("token");
  return psql(`SELECT consumed_at IS NOT NULL FROM magic_tokens WHERE token = '${token}'`);
}

test("opening the link only asks to continue; Continue signs in, once", async ({ page }) => {
  const link = mintMagicLink(EMAIL);

  await page.goto(link);
  await expect(page).toHaveURL(/\/login\/continue\?token=/);
  await expect(page.getByRole("heading", { name: "You're almost in" })).toBeVisible();
  expect(spent(link)).toBe("f");

  await page.getByRole("button", CONTINUE).click();
  await expect(page).toHaveURL(/\/inbox$/);
  expect(spent(link)).toBe("t");

  // The same link again, from a browser without that session (another device,
  // a forwarded email).
  await page.context().clearCookies();
  await page.goto(link);
  await page.getByRole("button", CONTINUE).click();
  await expect(page).toHaveURL(/\/login\?e=consumed$/);
  await expect(page.getByText("That link was already used.")).toBeVisible();
});

test("a link carrying next lands on that page after Continue", async ({ page }) => {
  const [shortId, title] = psql(
    `SELECT short_id, title FROM items
     WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'southbeam')
     ORDER BY seq LIMIT 1`,
  ).split("|") as [string, string];

  await page.goto(mintMagicLink(EMAIL, `/thread/${shortId}`));
  await page.getByRole("button", CONTINUE).click();
  await expect(page).toHaveURL(new RegExp(`/thread/${shortId}$`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
});

for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
  test(`next=${next} lands on the inbox`, async ({ page, baseURL }) => {
    const inbox = `${publicOrigin(new URL(baseURL!).origin)}/inbox`;

    await page.goto(mintMagicLink(EMAIL, next));
    await page.getByRole("button", CONTINUE).click();
    await expect(page).toHaveURL(inbox);

    // The Continue page already dropped it; the POST refuses it on its own too.
    const token = new URLSearchParams(mintMagicLink(EMAIL).split("?")[1]).get("token")!;
    const res = await page.request.post("/login/verify", { form: { token, next }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()["location"]).toBe(inbox);
  });
}
