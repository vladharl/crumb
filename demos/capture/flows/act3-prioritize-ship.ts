import type { Page } from "@playwright/test";
import { shot, demoClick, smoothScrollTo, pause } from "../lib";

// ACT 3 — PRIORITIZE BY REVENUE, SHIP TO ENGINEERING.
// The vendor weighs feedback by what each account pays, then the work goes to
// Linear as a ticket drafted from the feedback + the product's GitHub repo.
// All on-camera state is real, rendered UI backed by seeded DB rows (no live
// third-party calls): the accounts ARR view, the thread's account ARR card, the
// linked Linear ticket (ENG-482), and the connected Linear + GitHub integrations
// (the GitHub repo is the context source the AI draft pulls from).
export const name = "act3-prioritize-ship";

export async function record(page: Page): Promise<void> {
  // 1 — Prioritize by revenue: the accounts portfolio, sorted by ARR, with
  // "ARR with open feedback" and "At-risk ARR" up top.
  await page.goto("/accounts", { waitUntil: "networkidle" });
  await page.getByText(/Total ARR/i).first().waitFor({ timeout: 20_000 });
  await page.locator("text=Acme Co").first().waitFor({ timeout: 15_000 });
  await pause(page, 1500);
  await shot(page, "act3-1-accounts-arr");

  // 2 — On the hero thread, the account card ties this feedback to Acme's ARR.
  await page.goto("/thread/FB-247", { waitUntil: "networkidle" });
  await page.locator("body").waitFor();
  await page.getByText(/ARR$/).first().waitFor({ timeout: 15_000 }).catch(() => {});
  await pause(page, 900);

  const accountCard = page.locator("text=/ARR$/").first();
  if (await accountCard.isVisible().catch(() => false)) {
    await smoothScrollTo(page, accountCard, "center");
    await pause(page, 1000);
    await shot(page, "act3-2-thread-arr");
  }

  // 3 — The Engineering card: a Linear ticket already created from this
  // feedback (ENG-482, In Progress), drafted with the team's repo context.
  const engCard = page.locator("text=/Engineering/i").first();
  if (await engCard.isVisible().catch(() => false)) {
    await smoothScrollTo(page, engCard, "center");
    await pause(page, 1200);
    await shot(page, "act3-3-linear-ticket");
  }

  // 4 — Proof of the context source: Settings → Integrations shows Linear and
  // GitHub connected; the GitHub repo (southbeam/app) is what feeds the AI draft.
  await page.goto("/settings/integrations", { waitUntil: "networkidle" });
  await page.getByText(/Linear/).first().waitFor({ timeout: 15_000 });
  await pause(page, 1000);
  // Glide down to the GitHub card so the "default repo · feeds AI drafts" line reads.
  const githubCard = page.getByText(/GitHub/).first();
  if (await githubCard.isVisible().catch(() => false)) {
    await smoothScrollTo(page, githubCard, "center");
    await pause(page, 1100);
  }
  await shot(page, "act3-4-integrations");
  await pause(page, 800);
}
