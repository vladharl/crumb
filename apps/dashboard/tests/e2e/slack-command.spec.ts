import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

// Slack slash command signature verification + team resolution. The full modal
// round-trip needs a live Slack API, so we scope e2e to the security boundary
// (modal building + composeItem are covered by unit/typecheck). SLACK_SIGNING_
// SECRET is set by the webServer env in playwright.config.ts.

test.use({ storageState: { cookies: [], origins: [] } }); // unauthenticated public webhook

const SIGNING = "e2e-slack-signing";

function slackSig(body: string, ts: string): string {
  return `v0=${createHmac("sha256", SIGNING).update(`v0:${ts}:${body}`).digest("hex")}`;
}

test("rejects a slash command with a bad signature", async ({ request }) => {
  const body = "team_id=Tunknown&trigger_id=abc";
  const ts = String(Math.floor(Date.now() / 1000));
  const resp = await request.post("/api/integrations/slack/commands", {
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": "v0=bad" },
    data: body,
  });
  expect(resp.status()).toBe(401);
});

test("accepts a valid signature; unknown team gets an ephemeral nudge", async ({ request }) => {
  const body = "team_id=Tunknown&trigger_id=abc123";
  const ts = String(Math.floor(Date.now() / 1000));
  const resp = await request.post("/api/integrations/slack/commands", {
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": slackSig(body, ts) },
    data: body,
  });
  expect(resp.status()).toBe(200);
  expect(await resp.text()).toContain("isn't connected");
});
