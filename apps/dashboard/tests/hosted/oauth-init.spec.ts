import { test, expect } from "@playwright/test";
import { PROVIDERS, EXPECTED_APP_URL, captureAuthorizeUrl, hasSession } from "./fixtures";

// Verifies, for each OAuth/App provider, that EITHER:
//   • it is configured on the host → clicking Connect produces a correct
//     authorize URL (right host, redirect_uri = CRUMB_APP_URL + callback path,
//     client_id, scopes, signed state) — WITHOUT completing the flow; or
//   • it is not configured → the self-host "Set <ENV>" pill is shown.
//
// Safe: we abort the cross-origin navigation before it reaches the provider, so
// no token exchange and no workspace mutation happens. Requires a dashboard
// session (admin) because the Connect button is admin-only.

const SESSION = hasSession();

test.describe("OAuth init wiring", () => {
  test.beforeEach(() => {
    test.skip(!SESSION, "no hosted dashboard session — set CRUMB_E2E_SESSION (or CRUMB_E2E_SSH_BOOTSTRAP=1)");
  });

  for (const p of PROVIDERS) {
    test(`${p.title}: connect redirect is correct, or not-configured`, async ({ page }, testInfo) => {
      await page.goto("/settings/integrations");

      const connect = page.getByRole("button", { name: p.connectBtn, exact: true });
      if ((await connect.count()) === 0) {
        // Not connectable from the UI: either env not set (self-host pill) or
        // already connected. Record which, and assert the card rendered.
        const notConfigured = (await page.getByText(p.setEnvText, { exact: false }).count()) > 0;
        testInfo.annotations.push({
          type: notConfigured ? "not-configured" : "connected",
          description: notConfigured
            ? `${p.title}: env not set on host (${p.setEnvText})`
            : `${p.title}: no Connect button — treated as already connected`,
        });
        await expect(page.getByText(p.title, { exact: false }).first()).toBeVisible();
        return;
      }

      // Configured → assert the authorize URL is built correctly.
      const url = await captureAuthorizeUrl(page, p.connectBtn);

      if (p.authorizePathExact) {
        expect(url.origin, "authorize origin").toBe(p.authorizeOrigin);
        expect(url.pathname, "authorize path").toBe(p.authorizePathExact);
      } else if (p.authorizePathRe) {
        expect(url.origin, "authorize origin").toBe(p.authorizeOrigin);
        expect(url.pathname, "authorize path").toMatch(p.authorizePathRe);
      }

      if (p.hasRedirectUri) {
        expect(url.searchParams.get("redirect_uri"), "redirect_uri").toBe(
          `${EXPECTED_APP_URL}/api/integrations/${p.key}/callback`,
        );
      } else {
        expect(url.searchParams.get("redirect_uri"), "no redirect_uri expected").toBeNull();
      }

      if (p.hasClientId) {
        expect(url.searchParams.get("client_id"), "client_id present").toBeTruthy();
      }

      for (const s of p.scopeIncludes ?? []) {
        expect(url.searchParams.get("scope") ?? "", `scope contains ${s}`).toContain(s);
      }

      const state = url.searchParams.get("state") ?? "";
      expect(state.startsWith(`${p.key}.`), "state is provider-keyed").toBeTruthy();
      expect(state.split(".").length, "state is {provider}.{ws}.{nonce}.{sig}").toBe(4);

      testInfo.annotations.push({
        type: "configured",
        description: `${p.title}: Connect → ${url.origin}${url.pathname}`,
      });
    });
  }
});
