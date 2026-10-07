import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac, randomBytes } from "node:crypto";
import { psql, publicOrigin } from "./helpers/mint";

// An integration callback finishes only for the signed-in admin of the
// workspace its OAuth state was issued for, and redirects on the public origin
// (lib/integrations/callback.ts), never on req.url, which behind the tunnel is
// 0.0.0.0:3000. HubSpot reaches the state check with no provider env; with no
// HUBSPOT_CLIENT_* set, a callback that slipped past the gate would fail at the
// code exchange without calling out, and the exact redirects below would fail.
//
// States are minted like lib/integrations/state.ts signState. Its secret falls
// back from CRUMB_OAUTH_STATE_SECRET (unset in e2e) to CRUMB_INBOUND_SECRET,
// which playwright.config.ts sets to "e2e-inbound". The wrong-workspace and
// signed-out cases redirect past the state check, which proves these verify.

const STATE_SECRET = "e2e-inbound";

let southbeamId: string;
let otherId: string;

function hubspotState(workspaceId: string, opts: { secret?: string; issuedAt?: number } = {}): string {
  const body = `hubspot.${workspaceId}.${opts.issuedAt ?? Date.now()}.${randomBytes(16).toString("base64url")}`;
  return `${body}.${createHmac("sha256", opts.secret ?? STATE_SECRET).update(body).digest("base64url")}`;
}

// The callback's redirect target, relative to the public origin.
async function callback(request: APIRequestContext, baseURL: string, state: string): Promise<string> {
  const res = await request.get(`/api/integrations/hubspot/callback?code=e2e-code&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  const location = res.headers()["location"]!;
  const origin = publicOrigin(new URL(baseURL).origin);
  expect(location.startsWith(`${origin}/`), `${location} is on ${origin}`).toBe(true);
  return location.slice(origin.length);
}

function hubspotConnections(): string {
  return psql(
    `SELECT count(*) FROM workspaces WHERE id IN ('${southbeamId}', '${otherId}')
     AND (hubspot_installed_at IS NOT NULL OR hubspot_access_token IS NOT NULL)`,
  );
}

test.beforeAll(() => {
  southbeamId = psql("SELECT id FROM workspaces WHERE slug = 'southbeam'");
  otherId = psql(`INSERT INTO workspaces (slug, name) VALUES ('e2e-oauth-${Date.now()}', 'E2E OAuth Other') RETURNING id`);
});

test.afterAll(() => {
  psql(`DELETE FROM workspaces WHERE id = '${otherId}'`);
});

test("a forged or stale state is refused", async ({ request, baseURL }) => {
  const forged = hubspotState(southbeamId, { secret: "not-the-state-secret" });
  expect(await callback(request, baseURL!, forged)).toBe("/settings/integrations?hubspot=error_bad_state");

  const stale = hubspotState(southbeamId, { issuedAt: Date.now() - 11 * 60 * 1000 });
  expect(await callback(request, baseURL!, stale)).toBe("/settings/integrations?hubspot=error_bad_state");

  expect(hubspotConnections()).toBe("0");
});

test("another workspace's state is refused for this workspace's admin", async ({ request, baseURL }) => {
  expect(await callback(request, baseURL!, hubspotState(otherId))).toBe("/settings/integrations?hubspot=error_wrong_workspace");
  expect(hubspotConnections()).toBe("0");
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a valid state without a session goes to sign-in", async ({ request, baseURL }) => {
    expect(await callback(request, baseURL!, hubspotState(southbeamId))).toBe("/login");
    expect(hubspotConnections()).toBe("0");
  });
});
