import { test, expect, type Locator, type Page } from "@playwright/test";
import { psql } from "../e2e/helpers/mint";

// Billing for a Free Cloud workspace. The plan picker keeps the visitor's pick
// from the URL (signup, or a canceled Checkout) and shows the list prices when
// Stripe isn't configured, as here (lib/stripe.ts LIST_PRICES); the return from
// Checkout says what happened and waits for the webhook; and the paid features
// show locked, with the way to upgrade, instead of vanishing. Setup puts
// southbeam on an active Growth plan: each test makes it Free (plan_id free and
// no subscription, which is what a Free workspace is) and the end restores it.

const WS = "slug = 'southbeam'";
let saved: [plan: string, status: string];

test.beforeAll(() => {
  saved = psql(`SELECT plan_id, coalesce(subscription_status, '') FROM workspaces WHERE ${WS}`).split("|") as [string, string];
});
test.beforeEach(() => psql(`UPDATE workspaces SET plan_id = 'free', subscription_status = NULL WHERE ${WS}`));
test.afterAll(() => {
  const [plan, status] = saved;
  psql(`UPDATE workspaces SET plan_id = '${plan}', subscription_status = ${status ? `'${status}'` : "NULL"} WHERE ${WS}`);
});

const planCard = (page: Page, name: "Team" | "Growth") =>
  page.locator(".card.col", { has: page.locator(".serif.text-md", { hasText: new RegExp(`^${name}$`) }) });
const picked = (card: Locator) => card.evaluate((el) => (el as HTMLElement).style.borderColor === "var(--accent)");
const interval = (page: Page, label: "Monthly" | "Annual") =>
  page.getByRole("group", { name: "Billing interval" }).getByRole("button", { name: label });

test("a plan link preselects its plan and interval, at the list prices", async ({ page }) => {
  await page.goto("/settings/billing?plan=team&interval=month");
  await expect(page.getByText("Stripe isn't configured on this deployment.")).toBeVisible();

  const team = planCard(page, "Team");
  const growth = planCard(page, "Growth");
  await expect(interval(page, "Monthly")).toHaveAttribute("aria-pressed", "true");
  await expect(interval(page, "Annual")).toHaveAttribute("aria-pressed", "false");
  expect(await picked(team)).toBe(true);
  expect(await picked(growth)).toBe(false);

  // $24 and $49 a month; $19 and $39 a month billed annually.
  await expect(team).toContainText("$24/mo");
  await expect(team).toContainText("Billed monthly.");
  await expect(growth).toContainText("$49/mo");
  await expect(page.getByText("Save 20% with annual billing")).toBeVisible();

  await interval(page, "Annual").click();
  await expect(team).toContainText("$19/mo");
  await expect(team).toContainText("Billed $228 a year, saving $60.");
  await expect(growth).toContainText("$39/mo");
  await expect(growth).toContainText("Billed $468 a year, saving $120.");
});

test("a canceled Checkout says so and keeps the pick", async ({ page }) => {
  // The cancel_url createCheckoutSession hands Stripe.
  await page.goto("/settings/billing?stripe=cancel&plan=growth&interval=year");
  await expect(page.getByRole("status")).toHaveText("Checkout canceled. You weren't charged.");
  await expect(interval(page, "Annual")).toHaveAttribute("aria-pressed", "true");
  expect(await picked(planCard(page, "Growth"))).toBe(true);
  expect(await picked(planCard(page, "Team"))).toBe(false);
});

test("back from a paid Checkout, it says the plan is activating and polls until the webhook lands", async ({ page }) => {
  // router.refresh() refetches this page's server components (an RSC request).
  let refreshes = 0;
  page.on("request", (req) => {
    const h = req.headers();
    if (new URL(req.url()).pathname === "/settings/billing" && h["rsc"] === "1" && !h["next-router-prefetch"]) refreshes++;
  });

  await page.goto("/settings/billing?stripe=success");
  await expect(page.getByRole("status")).toHaveText("Payment received. Activating your plan…");
  // No picker while it waits, so a slow activation can't invite a second payment.
  await expect(page.getByRole("group", { name: "Billing interval" })).toHaveCount(0);
  await expect.poll(() => refreshes, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  // What the Stripe webhook writes; the next poll picks it up.
  psql(`UPDATE workspaces SET plan_id = 'team', subscription_status = 'active' WHERE ${WS}`);
  await expect(page.getByRole("status")).toHaveText(
    "Payment received. You're on the Team plan now. Thanks for upgrading.",
    { timeout: 10_000 },
  );
});

test("on Free, AI shows locked with the way to upgrade, not hidden", async ({ page }) => {
  const AI = "The Team plan adds the AI suite: clustering, Ask, ticket and reply drafts.";

  await page.goto("/inbox");
  const cluster = page.getByRole("button", { name: "Cluster with AI" });
  await expect(cluster).toHaveAttribute("aria-expanded", "false");
  await cluster.click();
  await expect(cluster).toHaveAttribute("aria-expanded", "true");
  const notice = page.getByRole("note").filter({ hasText: AI });
  await expect(notice.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/settings/billing?plan=team");

  // Ask stays in the nav and opens on the same notice.
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await expect(page).toHaveURL(/\/ask$/);
  await page.getByRole("note").filter({ hasText: AI }).getByRole("link", { name: "See plans" }).click();
  await expect(page).toHaveURL(/\/settings\/billing\?plan=team$/);
  expect(await picked(planCard(page, "Team"))).toBe(true);
});

test("integrations shows the admin a neutral upgrade notice with See plans", async ({ page }) => {
  await page.goto("/settings/integrations");
  const notice = page.getByRole("note").filter({
    hasText: "The Team plan adds one-click Slack, Linear, Jira and GitHub, plus CRM sync and feedback connectors.",
  });
  await expect(notice.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/settings/billing?plan=team");
  // Neutral: the card surface, not the success or error banner.
  expect(await notice.evaluate((el) => (el as HTMLElement).style.background)).toBe("var(--surface)");
  // Session replay names the plan that has it.
  await expect(
    page.getByRole("note").filter({ hasText: "The Growth plan adds session replay." }).getByRole("link", { name: "See plans" }),
  ).toHaveAttribute("href", "/settings/billing?plan=growth");
});

test("a Team subscriber's notice says Change plan, and billing offers Growth above it", async ({ page }) => {
  psql(`UPDATE workspaces SET plan_id = 'team', subscription_status = 'active' WHERE ${WS}`);
  await page.goto("/settings/integrations");
  await page.getByRole("note").filter({ hasText: "The Growth plan adds session replay." })
    .getByRole("link", { name: "Change plan" }).click();

  await expect(page).toHaveURL(/\/settings\/billing\?plan=growth$/);
  // Only the plan above Team, preselected. (Its Upgrade button opens the Stripe
  // portal, so it shows only where Stripe is configured; not in e2e.)
  await expect(planCard(page, "Growth")).toBeVisible();
  await expect(planCard(page, "Team")).toHaveCount(0);
  expect(await picked(planCard(page, "Growth"))).toBe(true);
});
