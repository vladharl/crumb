import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Request } from "@playwright/test";

// ─── Env contract ─────────────────────────────────────────────────────────
//   CRUMB_E2E_HOSTED_URL      base URL of the deployment to verify
//                             (default https://crumb-app.localhostlabs.net)
//   CRUMB_E2E_SESSION         raw `crumb_session` cookie → enables UI specs
//   CRUMB_E2E_API_KEY         `crumb_sk_…` bearer → enables MCP specs
//   CRUMB_E2E_EXPECTED_APP_URL expected CRUMB_APP_URL for redirect_uri asserts
//                             (default = base URL; the public origin)
//   CRUMB_E2E_EDITION         "community" (default) | "cloud" — switches the
//                             cloud-gating expectations (404 vs 4xx)
//   SSH bootstrap (opt-in, global setup only): CRUMB_E2E_SSH_BOOTSTRAP=1,
//     CRUMB_E2E_SSH_HOST (default eissa-vps), CRUMB_E2E_ADMIN_EMAIL,
//     CRUMB_E2E_PG_CONTAINER/USER/DB.

export const BASE_URL = process.env.CRUMB_E2E_HOSTED_URL ?? "https://crumb-app.localhostlabs.net";

// The origin we expect every OAuth redirect_uri to be rooted at. On the host
// CRUMB_APP_URL is the canonical public origin, so it equals BASE_URL unless an
// operator overrides it (e.g. a separate proxy host).
export const EXPECTED_APP_URL = (process.env.CRUMB_E2E_EXPECTED_APP_URL ?? BASE_URL).replace(/\/+$/, "");

export const EDITION = (process.env.CRUMB_E2E_EDITION ?? "community").toLowerCase();
export const IS_CLOUD_EDITION = EDITION === "cloud";

export const API_KEY = process.env.CRUMB_E2E_API_KEY?.trim() || null;

// True when global setup obtained a dashboard session (storageState has a cookie).
export function hasSession(): boolean {
  try {
    const raw = readFileSync(resolve(__dirname, ".auth/admin.json"), "utf8");
    const state = JSON.parse(raw) as { cookies?: unknown[] };
    return Array.isArray(state.cookies) && state.cookies.length > 0;
  } catch {
    return false;
  }
}

// ─── OAuth provider metadata ──────────────────────────────────────────────
// Mirrors lib/slack/install.ts, lib/integrations/{linear,jira,github}.ts and
// lib/integrations/crm/{hubspot,salesforce}.ts. `key` is the callback path
// segment AND the state prefix (lib/integrations/state.ts).

export type ProviderMeta = {
  key: string;            // slack | linear | jira | github | hubspot | salesforce
  title: string;         // card title shown on /settings/integrations
  connectBtn: string;    // exact accessible name of the Connect button
  setEnvText: string;    // self-host "not configured" pill text (unique per provider)
  authorizeOrigin: string;
  authorizePathExact?: string;
  authorizePathRe?: RegExp;
  hasRedirectUri: boolean;
  hasClientId: boolean;
  scopeIncludes?: string[]; // substrings expected in the `scope` param
};

export const PROVIDERS: ProviderMeta[] = [
  {
    key: "slack",
    title: "Vendor-side Slack",
    connectBtn: "Connect Slack",
    setEnvText: "Set SLACK_CLIENT_ID",
    authorizeOrigin: "https://slack.com",
    authorizePathExact: "/oauth/v2/authorize",
    hasRedirectUri: true,
    hasClientId: true,
    scopeIncludes: ["chat:write", "im:write", "users:read", "users:read.email"],
  },
  {
    key: "linear",
    title: "Linear",
    connectBtn: "Connect Linear",
    setEnvText: "Set LINEAR_CLIENT_ID",
    authorizeOrigin: "https://linear.app",
    authorizePathExact: "/oauth/authorize",
    hasRedirectUri: true,
    hasClientId: true,
    scopeIncludes: ["read", "write"],
  },
  {
    key: "jira",
    title: "Jira",
    connectBtn: "Connect Jira",
    setEnvText: "Set JIRA_CLIENT_ID",
    authorizeOrigin: "https://auth.atlassian.com",
    authorizePathExact: "/authorize",
    hasRedirectUri: true,
    hasClientId: true,
    scopeIncludes: ["read:jira-work", "write:jira-work", "offline_access"],
  },
  {
    key: "github",
    title: "GitHub",
    connectBtn: "Install GitHub App",
    setEnvText: "Set GITHUB_APP_*",
    authorizeOrigin: "https://github.com",
    // /apps/<slug>/installations/new
    authorizePathRe: /^\/apps\/[^/]+\/installations\/new$/,
    hasRedirectUri: false, // GitHub App install URL carries no redirect_uri
    hasClientId: false,
    scopeIncludes: undefined,
  },
  {
    key: "hubspot",
    title: "HubSpot",
    connectBtn: "Connect HubSpot",
    setEnvText: "Set HUBSPOT_CLIENT_ID",
    authorizeOrigin: "https://app.hubspot.com",
    authorizePathExact: "/oauth/authorize",
    hasRedirectUri: true,
    hasClientId: true,
    scopeIncludes: ["crm.objects.companies.read"],
  },
  {
    key: "salesforce",
    title: "Salesforce",
    connectBtn: "Connect Salesforce",
    setEnvText: "Set SALESFORCE_CLIENT_ID",
    // Default login host; a sandbox (SALESFORCE_LOGIN_URL) would differ — the
    // spec asserts the path, and only asserts the origin for the default host.
    authorizeOrigin: "https://login.salesforce.com",
    authorizePathExact: "/services/oauth2/authorize",
    hasRedirectUri: true,
    hasClientId: true,
    scopeIncludes: ["api", "refresh_token"],
  },
];

// Regex matching every provider authorize host, for route-abort + waitForRequest.
export const PROVIDER_HOST_RE =
  /^https:\/\/(slack\.com|linear\.app|auth\.atlassian\.com|github\.com|app\.hubspot\.com|login\.salesforce\.com|test\.salesforce\.com)\//;

// Click a provider's Connect button and capture the authorize URL it was about
// to navigate to, WITHOUT loading the external provider page. We abort the
// cross-origin navigation (so no request is ever completed to the provider) but
// `waitForRequest` still hands us the URL Playwright was about to open.
export async function captureAuthorizeUrl(page: Page, buttonName: string): Promise<URL> {
  await page.route(PROVIDER_HOST_RE, (route) => route.abort());
  const [req] = await Promise.all([
    page.waitForRequest(PROVIDER_HOST_RE, { timeout: 15_000 }),
    page.getByRole("button", { name: buttonName, exact: true }).click(),
  ]);
  return new URL((req as Request).url());
}
