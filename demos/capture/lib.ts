import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { SHOTS_DIR } from "./config";

// Re-export the cursor helpers so flows import everything from one place.
export * from "./cursor";

// Save a committed PNG deliverable (Retina-crisp via the context's
// deviceScaleFactor). Lands in docs/assets/screenshots/<name>.png.
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS_DIR, `${name}.png`) });
}
