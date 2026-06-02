import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import {
  BASE_URL, VIEWPORT, DEVICE_SCALE, SLOWMO, HEADLESS,
  PG_CONTAINER, PG_USER, PG_DB, ADMIN_EMAIL, WORKSPACE_SLUG,
} from "./config";
import { createAuthState } from "./auth";
import { installCursor } from "./cursor";
import { shot, demoClick, pause } from "./lib";

// NEW-VISION FEATURE SHOTS.
// Stills of the UX/IA refresh that the three story acts don't naturally pass
// through: the first-run onboarding tour, the merged "Needs triage" inbox, the
// ⌘K command palette, and the notification bell. No video here — these are
// single PNGs for the docs, so we skip recordVideo (keeps the gif pipeline to
// the three act clips). Assumes the app is up at BASE_URL and the DB has been
// seeded + staged (`pnpm db:seed && pnpm -C demos stage`).

function psql(sql: string): string {
  const cmd = `docker exec -i ${PG_CONTAINER} psql -v ON_ERROR_STOP=1 -tA -U ${PG_USER} -d ${PG_DB} -c "${sql.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const WS = `(SELECT id FROM workspaces WHERE slug='${WORKSPACE_SLUG}')`;

// The tour auto-opens when guide_completed_at is null. stage.ts marks the whole
// team done so it stays out of the act shots; we flip the captured admin back to
// null just long enough to photograph it, then restore.
function setTourDone(done: boolean): void {
  psql(`UPDATE workspace_users SET guide_completed_at = ${done ? "now()" : "NULL"} WHERE workspace_id=${WS} AND email='${ADMIN_EMAIL}'`);
}

async function main(): Promise<void> {
  console.log("[demos] minting a session for the seeded admin…");
  const storageState = createAuthState();

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
  try {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      storageState: storageState as NonNullable<Parameters<typeof browser.newContext>[0]>["storageState"],
    });
    const page = await context.newPage();
    await installCursor(page);
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);

    // 1 — First-run onboarding tour (spotlight on the Inbox tab, step 1 of 7).
    console.log("[demos] feat-tour …");
    setTourDone(false);
    await page.goto("/inbox", { waitUntil: "networkidle" });
    await page.getByRole("dialog", { name: /getting started/i }).waitFor({ timeout: 15_000 }).catch(() => {});
    await page.locator("text=Your Inbox").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await page.mouse.move(720, 720); // park the cursor clear of the callout
    await pause(page, 1200);
    await shot(page, "feat-tour");
    setTourDone(true);

    // 2 — Merged inbox: the "Needs triage" card of forwarded captures up top.
    console.log("[demos] feat-needs-triage …");
    await page.goto("/inbox", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /^Inbox$/ }).waitFor({ timeout: 20_000 });
    await page.locator("text=/Needs triage/").first().waitFor({ timeout: 15_000 });
    await page.mouse.move(1150, 730);
    await pause(page, 1200);
    await shot(page, "feat-needs-triage");

    // 3 — ⌘K command palette (open via the top-bar trigger — deterministic).
    console.log("[demos] feat-cmdk …");
    await demoClick(page, page.locator(".cmdk-btn"));
    await page.locator(".cmdk").waitFor({ timeout: 10_000 });
    await page.locator(".cmdk-opt").first().waitFor({ timeout: 5_000 }).catch(() => {});
    await pause(page, 900);
    await shot(page, "feat-cmdk");
    await page.keyboard.press("Escape");
    await pause(page, 400);

    // 4 — Notification bell popover.
    console.log("[demos] feat-bell …");
    await demoClick(page, page.locator('[data-tour="notifs"]'));
    await page.locator(".bell-pop").waitFor({ timeout: 10_000 });
    await page.locator(".bell-row, .bell-empty").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await pause(page, 1000);
    await shot(page, "feat-bell");
  } finally {
    await browser.close();
  }
  console.log("[demos] feature shots done → docs/assets/screenshots/feat-*.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
