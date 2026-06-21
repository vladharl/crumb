import { defineConfig, devices } from "@playwright/test";

// ─── Hosted verification suite ────────────────────────────────────────────
//
// Runs against an ALREADY-RUNNING, live Crumb deployment (default: the public
// host) to verify every integration is wired correctly. UNLIKE the local
// `playwright.config.ts`, this config:
//   • has NO `webServer` — it never boots a server, it probes a remote one;
//   • NEVER re-seeds or migrates the DB — its global setup is read-only/additive;
//   • authenticates with pre-provisioned credentials (a session cookie + an API
//     key) supplied via env, so it can run from CI without touching the host's
//     data.
//
// Every assertion is "safe ops only": read-only reads, additive rows that
// auto-expire, and negative/auth-rejection checks. No status mutations, no real
// OAuth token exchange, no destructive sweeps. See tests/hosted/README.md.
//
// Run:  CRUMB_E2E_SESSION=… CRUMB_E2E_API_KEY=… pnpm test:e2e:hosted
// Env contract: tests/hosted/fixtures.ts (top of file).

const baseURL = process.env.CRUMB_E2E_HOSTED_URL ?? "https://crumb-app.localhostlabs.net";

export default defineConfig({
  testDir: "./tests/hosted",
  fullyParallel: false, // gentle on a shared live host
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  globalSetup: "./tests/hosted/setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    // Written by global setup. Holds the `crumb_session` cookie when a session
    // is available, or an empty state when it isn't (UI specs then self-skip).
    storageState: "./tests/hosted/.auth/admin.json",
    ignoreHTTPSErrors: false, // real cert behind Cloudflare — don't mask TLS problems
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // NO webServer: this suite targets a remote, already-running deployment.
});
