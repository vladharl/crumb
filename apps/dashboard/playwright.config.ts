import { defineConfig, devices } from "@playwright/test";

// E2E tests against `next dev` + the docker Postgres. Tests live in
// `tests/e2e/`. Authentication is handled by a global-setup hook that
// re-seeds the DB and creates a session token in the `sessions` table —
// individual tests start already-signed-in via a cookie.
//
// Port contract: tests assume the dev server on `http://localhost:3000`.
// If a teammate runs the dashboard on a different port, override
// `CRUMB_E2E_BASE_URL` in the environment.
//
// Local browser install: `npx playwright install chromium`. CI installs
// with --with-deps in `.github/workflows/test.yml`.

const baseURL = process.env.CRUMB_E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // tests share DB state (the seeded fixture)
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    storageState: "./tests/e2e/.auth/admin.json",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
