import { defineConfig, devices } from "@playwright/test";

// Cloud-tier AI e2e suite. Boots TWO webServers: the deterministic AI stub and
// the dashboard with CRUMB_TIER=cloud + the AI base URLs pointed at the stub +
// a paid seeded plan (see tests/e2e-ai/setup.ts), so the Cloud-only AI features
// (triage, dedup, Ask, reply/translation, replay summaries) actually run.
//
// Kept separate from playwright.config.ts because the two need different
// webServer env, and the self_host suite must keep its trusted-email + 410
// behaviours. Run with: pnpm test:e2e:ai. Don't run both configs concurrently
// (both bind :3000) — CI runs them as separate jobs.

const baseURL = process.env.CRUMB_E2E_BASE_URL ?? "http://localhost:3000";
const AI_STUB = "http://localhost:3939";

export default defineConfig({
  testDir: "./tests/e2e-ai",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/e2e-ai/setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    storageState: "./tests/e2e-ai/.auth/admin.json",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "node tests/e2e/ai-stub/server.mjs",
      url: `${AI_STUB}/health`,
      reuseExistingServer: true,
      timeout: 20_000,
    },
    {
      command: "pnpm dev",
      url: baseURL,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        CRUMB_TIER: "cloud",
        AISTACK_API_KEY: "e2e",
        AISTACK_BASE_URL: `${AI_STUB}/v1`,
        EMBEDDINGS_BASE_URL: `${AI_STUB}/v1`,
        AISTACK_EMBEDDINGS_MODEL: "stub-embed",
        CRUMB_APP_URL: baseURL,
        CRUMB_INBOUND_SECRET: "e2e-inbound",
        CRUMB_INBOUND_DOMAIN: "crumb.test",
        CRUMB_WEBHOOK_ALLOW_ANY: "1",
      },
    },
  ],
});
