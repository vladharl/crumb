import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  BASE_URL, VIEWPORT, DEVICE_SCALE, SLOWMO, HEADLESS, CLIPS_DIR, OUT_DIR,
} from "./config";
import { createAuthState } from "./auth";
import { installCursor } from "./cursor";

import * as act1Customer from "./flows/act1-customer";
import * as act2VendorLoop from "./flows/act2-vendor-loop";
import * as act3PrioritizeShip from "./flows/act3-prioritize-ship";

// Order matters — these are the three acts of one story, captured in sequence.
const FLOWS = [act1Customer, act2VendorLoop, act3PrioritizeShip];

async function main(): Promise<void> {
  const only = process.argv[2]; // optional: capture a single flow by name
  const flows = only ? FLOWS.filter((f) => f.name === only) : FLOWS;
  if (flows.length === 0) {
    throw new Error(`Unknown flow "${only}". Available: ${FLOWS.map((f) => f.name).join(", ")}`);
  }

  mkdirSync(CLIPS_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("[demos] minting a session for the seeded admin…");
  const storageState = createAuthState();

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
  try {
    for (const flow of flows) {
      console.log(`[demos] capturing "${flow.name}" → ${BASE_URL}`);
      const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE,
        storageState: storageState as NonNullable<Parameters<typeof browser.newContext>[0]>["storageState"],
        recordVideo: { dir: OUT_DIR, size: VIEWPORT },
      });
      const page = await context.newPage();
      await installCursor(page);
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2); // park centre

      try {
        await flow.record(page);
      } catch (err) {
        console.error(`[demos] flow "${flow.name}" errored (continuing):`, err);
      }

      const video = page.video();
      await context.close(); // finalizes the .webm
      if (video) {
        const dest = resolve(CLIPS_DIR, `${flow.name}.webm`);
        if (existsSync(dest)) rmSync(dest);
        await video.saveAs(dest);
        await video.delete().catch(() => {});
        console.log(`[demos]   ↳ clip ${dest}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log("[demos] done. Clips → public/clips, screenshots → docs/assets/screenshots");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
