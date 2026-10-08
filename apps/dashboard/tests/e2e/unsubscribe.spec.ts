import { test, expect } from "@playwright/test";
import { mintUnsubscribeLink, mintWidgetJwt, psql, publicOrigin, stdoutEmails, type StdoutEmail } from "./helpers/mint";

// Customer emails carry a per-customer unsubscribe link: account_users.unsub_token
// is the capability (no login), and the scope says what it mutes: status,
// replies or roadmap, or all customer email with none (app/api/v1/unsubscribe).
// A GET only asks, since mail scanners open every link; the confirm form's POST
// applies, Undo turns it back on, and an inbox's RFC 8058 one-click POST
// applies with no page. Links are minted for a seeded customer as the senders
// build them; Shipping that customer's item prints the real email, headers and
// all, to the dev log.

const SLUG = "southbeam";
const EMAIL = "sam@vora.studio"; // seeded Vora Studio customer no other spec uses
const ON = { replies: true, status: true, roadmap: true, all: false };
type Prefs = typeof ON;

const customer = (email: string) =>
  `email = '${email}' AND workspace_id = (SELECT id FROM workspaces WHERE slug = '${SLUG}')`;

function prefs(email = EMAIL): Prefs {
  const [replies, status, roadmap, all] = psql(
    `SELECT notify_replies, notify_status, notify_roadmap, unsubscribed_all FROM account_users WHERE ${customer(email)}`,
  ).split("|").map((v) => v === "t");
  return { replies: replies!, status: status!, roadmap: roadmap!, all: all! };
}

function setPrefs(p: Prefs): void {
  psql(
    `UPDATE account_users SET notify_replies = ${p.replies}, notify_status = ${p.status},
     notify_roadmap = ${p.roadmap}, unsubscribed_all = ${p.all} WHERE ${customer(EMAIL)}`,
  );
}

const workspaceName = () => psql(`SELECT name FROM workspaces WHERE slug = '${SLUG}'`);

test.beforeEach(() => setPrefs(ON));
test.afterAll(() => setPrefs(ON));

test.describe("from the customer's inbox, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the link only asks; Confirm mutes only its scope, and Undo turns it back on", async ({ page }) => {
    const ws = workspaceName();
    const res = await page.goto(mintUnsubscribeLink(SLUG, EMAIL, "status"));
    expect(res?.status()).toBe(200);

    // Branded: the workspace's name over Crumb's paper page, then the question.
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(251, 247, 240)");
    await expect(page.locator(".eyebrow")).toHaveText(ws);
    await expect(page.getByRole("heading", { name: "Unsubscribe from status changes?" })).toBeVisible();
    await expect(page.getByText(`${ws} will stop emailing you when your feedback changes status.`)).toBeVisible();
    expect(prefs()).toEqual(ON);

    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { name: "You’re unsubscribed" })).toBeVisible();
    await expect(page.getByText(`${ws} will no longer email you when your feedback changes status.`)).toBeVisible();
    expect(prefs()).toEqual({ ...ON, status: false });

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("heading", { name: "Emails are back on" })).toBeVisible();
    expect(prefs()).toEqual(ON);
  });

  test("a one-click POST (RFC 8058) mutes its scope with no page", async ({ request }) => {
    const MUTES: Array<[scope: "replies" | "status" | "roadmap" | undefined, muted: Partial<Prefs>]> = [
      [undefined, { all: true }],
      ["status", { status: false }],
      ["replies", { replies: false }],
      ["roadmap", { roadmap: false }],
    ];
    for (const [scope, muted] of MUTES) {
      setPrefs(ON);
      const res = await request.post(mintUnsubscribeLink(SLUG, EMAIL, scope), {
        form: { "List-Unsubscribe": "One-Click" },
      });
      expect(res.status()).toBe(200);
      expect(await res.text()).toBe("");
      expect(prefs(), `scope ${scope ?? "(all)"}`).toEqual({ ...ON, ...muted });
    }
  });

  test("a tampered link changes nothing", async ({ request }) => {
    const query = new URLSearchParams(mintUnsubscribeLink(SLUG, EMAIL).split("?")[1]);
    const u = query.get("u")!;
    const t = query.get("t")!;
    const otherEmail = "tao@pinedrop.com";
    const other = psql(`SELECT id FROM account_users WHERE ${customer(otherEmail)}`);
    const otherBefore = prefs(otherEmail);

    const forged = [
      { u, t: (t[0] === "a" ? "b" : "a") + t.slice(1) }, // one hex digit off
      { u, t: t.slice(0, -1) },                           // cut short
      { u: other, t },                                     // a real token on someone else
    ];
    for (const q of forged) {
      const path = `/api/v1/unsubscribe?${new URLSearchParams(q)}`;
      const get = await request.get(path);
      expect(get.status()).toBe(400);
      expect(await get.text()).toContain("This link doesn’t work");
      expect((await request.post(path, { form: { action: "unsubscribe" } })).status()).toBe(400);
      expect((await request.post(path, { form: { "List-Unsubscribe": "One-Click" } })).status()).toBe(400);
    }
    expect(prefs()).toEqual(ON);
    expect(prefs(otherEmail)).toEqual(otherBefore);
  });
});

test("Shipping the customer's item emails them as the workspace, with one-click unsubscribe headers", async ({ page, request, baseURL }) => {
  test.skip(stdoutEmails() === null, "Set CRUMB_E2E_DEV_LOG to the dev server's log file to read the email lib/email/stdout.ts prints there.");

  const ws = workspaceName();
  const title = `Unsubscribe headers ${Date.now()}`;
  const created = await request.post("/api/v1/items", {
    headers: { authorization: `Bearer ${mintWidgetJwt(SLUG, { sub: EMAIL, account_name: "Vora Studio" })}` },
    data: { type: "idea", title, body: "Tell me when it ships." },
  });
  expect(created.status()).toBe(201);
  const shortId = (await created.json()).short_id as string;
  // Filed by the seeded customer the links are minted for, not a new one.
  expect(psql(
    `SELECT au.email FROM items i JOIN account_users au ON au.id = i.submitter_id
     WHERE i.short_id = '${shortId}' AND i.workspace_id = (SELECT id FROM workspaces WHERE slug = '${SLUG}')`,
  )).toBe(EMAIL);

  // The thread's own status move. stdout isn't a delivery, so the toast says
  // Sam wasn't emailed even though the email is printed.
  await page.goto(`/thread/${shortId}`);
  await page.getByRole("button", { name: "Shipped", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark Shipped" }).click();
  await expect(page.getByText("Marked Shipped. Sam wasn't emailed.")).toBeVisible();

  const subject = `Shipped: ${title}`;
  let email: StdoutEmail | undefined;
  await expect
    .poll(() => (email = stdoutEmails()!.find((e) => e.to === EMAIL && e.subject === subject)), { timeout: 15_000 })
    .toBeTruthy();
  expect(email!.from).toMatch(new RegExp(`^"${ws} via Crumb" <[^>]+>$`));
  // The mailbox's own Unsubscribe button stops all of this workspace's email to
  // them (the footer link keeps the per-type choice).
  const origin = publicOrigin(new URL(baseURL!).origin);
  expect(email!["List-Unsubscribe"]).toBe(`<${origin}${mintUnsubscribeLink(SLUG, EMAIL)}>`);
  expect(email!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
});
