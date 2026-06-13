import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";
import {
  BASE_URL, VIEWPORT, DEVICE_SCALE, SLOWMO, HEADLESS,
  PG_CONTAINER, PG_USER, PG_DB, ADMIN_EMAIL, WORKSPACE_SLUG,
} from "./config";
import { createAuthState } from "./auth";
import { installCursor } from "./cursor";
import { shot, demoClick, demoType, moveTo, pause, smoothScrollTo } from "./lib";

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
    await page.keyboard.press("Escape");
    await pause(page, 400);

    // 5 — Compose modal, filled out as the "customer called instead" story.
    // We never click "Create item", so the shot leaves no item behind (Escape
    // keeps the draft client-side only).
    console.log("[demos] feat-compose …");
    await demoClick(page, page.getByRole("button", { name: "Compose" }));
    const modal = page.locator('[role="dialog"][aria-label="Compose on behalf"]');
    await modal.waitFor({ timeout: 10_000 });
    await demoType(page, modal.locator('input[list="known-accounts"]'), "Lumen Health");
    await demoType(page, modal.locator('input[type="email"]'), "priya@lumenhealth.com");
    await demoClick(page, modal.locator(".seg button", { hasText: "Bug" }));
    await demoType(page, modal.locator('input[placeholder*="gist"]'), "CSV export times out on large cohorts");
    await demoType(
      page,
      modal.locator("textarea"),
      "Priya called: the export spinner runs for about two minutes and then fails on their biggest cohort. Happens every Friday when they prep the board pack.",
    );
    await page.mouse.move(180, 720); // park clear of the modal
    await pause(page, 900);
    await shot(page, "feat-compose");
    await page.keyboard.press("Escape");
    await pause(page, 500);

    // 6 — Per-row "⋯" quick actions, root pane open on the first inbox row.
    // Center the row first: the staged Needs-triage card pushes the table down,
    // and a menu opened at the viewport's bottom edge gets clipped.
    console.log("[demos] feat-row-actions …");
    const rowMenuBtn = page.locator('button[aria-label^="Actions for"]').first();
    await smoothScrollTo(page, rowMenuBtn, "center");
    await demoClick(page, rowMenuBtn);
    await page.locator(".dd-menu").waitFor({ timeout: 10_000 });
    await page.locator(".dd-opt", { hasText: "Open thread" }).waitFor({ timeout: 5_000 });
    await pause(page, 900);
    await shot(page, "feat-row-actions");
    await page.keyboard.press("Escape");
    await pause(page, 400);

    // 7 — Settings overview: the 5-step setup checklist.
    console.log("[demos] feat-setup …");
    await page.goto("/settings", { waitUntil: "networkidle" });
    await page.locator("text=/\\d of 5 done/").waitFor({ timeout: 15_000 });
    await page.mouse.move(1180, 740);
    await pause(page, 1200);
    await shot(page, "feat-setup");

    // 8 — Edge-whisper launcher on the mock host page, hovered so the flag
    // with the latest loop event slides out. Fresh context = empty
    // localStorage, so the seeded replies/status moves read as news for the
    // widget's default identity (maya@acme.co).
    console.log("[demos] feat-whisper …");
    await page.goto("/widget-demo.html", { waitUntil: "networkidle" });
    const launcher = page.locator(".launcher");
    await launcher.waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('.launcher[data-state="news"]').waitFor({ timeout: 10_000 }).catch(() => {
      console.warn("[demos] launcher has no loop news; flag will show the rest-state text");
    });
    await moveTo(page, launcher); // hover slides the flag out
    await pause(page, 1300);
    await shot(page, "feat-whisper");
  } finally {
    await browser.close();
  }
  console.log("[demos] feature shots done → docs/assets/screenshots/feat-*.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
