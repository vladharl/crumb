import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Path anchors, resolved from this file so scripts work regardless of cwd.
const HERE = dirname(fileURLToPath(import.meta.url)); // demos/capture
export const PKG_ROOT = resolve(HERE, "..");          // demos
export const REPO_ROOT = resolve(PKG_ROOT, "..");     // crumb

// The running app. Point at a production build (`next build && next start`) for
// jank-free video — dev-mode on-demand compilation shows up in recordings.
export const BASE_URL = process.env.CRUMB_DEMO_BASE_URL ?? "http://localhost:3000";

// 16:10 desktop frame. deviceScaleFactor 2 → Retina-crisp PNGs.
export const VIEWPORT = { width: 1280, height: 800 };
export const DEVICE_SCALE = 2;

// Deliberate slow-motion so the eye can follow the action.
export const SLOWMO = Number(process.env.CRUMB_DEMO_SLOWMO ?? 110);
export const HEADLESS = process.env.CRUMB_DEMO_HEADED !== "1";

// Outputs.
export const CLIPS_DIR = resolve(PKG_ROOT, "public/clips");          // raw webm → Remotion + gif (gitignored)
export const SHOTS_DIR = resolve(REPO_ROOT, "docs/assets/screenshots"); // committed PNG deliverables
export const OUT_DIR = resolve(PKG_ROOT, "out");                     // scratch + final rendered video

// Seeded fixture + DB access — mirrors apps/dashboard/tests/e2e/setup.ts.
export const PG_CONTAINER = process.env.CRUMB_PG_CONTAINER ?? "crumb-postgres";
export const PG_USER = process.env.CRUMB_PG_USER ?? "crumb";
export const PG_DB = process.env.CRUMB_PG_DB ?? "crumb";
export const ADMIN_EMAIL = process.env.CRUMB_DEMO_ADMIN ?? "lina@southbeam.io";
export const WORKSPACE_SLUG = process.env.CRUMB_DEMO_WORKSPACE ?? "southbeam";
