import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

// Slack Events API endpoint (Phase-0 sizing bot). The full sizing round-trip
// needs a live Slack API + AI, so e2e scopes to the security boundary and the
// synchronous acks: signature verification, the url_verification handshake,
// retry short-circuit, and a clean 200 for an app_mention on an unknown team
// (the async processor exits at the workspace lookup). SLACK_SIGNING_SECRET is
// set by the webServer env in playwright.config.ts.

test.use({ storageState: { cookies: [], origins: [] } }); // unauthenticated public webhook

const SIGNING = "e2e-slack-signing";
const PATH = "/api/integrations/slack/events";

function slackSig(body: string, ts: string): string {
  return `v0=${createHmac("sha256", SIGNING).update(`v0:${ts}:${body}`).digest("hex")}`;
}

function now(): string {
  return String(Math.floor(Date.now() / 1000));
}

test("rejects an event with a bad signature", async ({ request }) => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
  const ts = now();
  const resp = await request.post(PATH, {
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": "v0=bad" },
    data: body,
  });
  expect(resp.status()).toBe(401);
});

test("answers the url_verification challenge", async ({ request }) => {
  const body = JSON.stringify({ type: "url_verification", challenge: "challenge-token-123" });
  const ts = now();
  const resp = await request.post(PATH, {
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": slackSig(body, ts) },
    data: body,
  });
  expect(resp.status()).toBe(200);
  expect((await resp.json()).challenge).toBe("challenge-token-123");
});

test("short-circuits Slack retries", async ({ request }) => {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "Tunknown",
    event: { type: "app_mention", user: "U1", text: "<@U0> add bulk export", channel: "C1", ts: "1.2" },
  });
  const ts = now();
  const resp = await request.post(PATH, {
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": slackSig(body, ts),
      "x-slack-retry-num": "1",
    },
    data: body,
  });
  expect(resp.status()).toBe(200);
});

test("accepts a signed app_mention; unknown team acks without crashing", async ({ request }) => {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "Tunknown",
    event: { type: "app_mention", user: "U1", text: "<@U0> add bulk export", channel: "C1", ts: "1.2" },
  });
  const ts = now();
  const resp = await request.post(PATH, {
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": slackSig(body, ts) },
    data: body,
  });
  expect(resp.status()).toBe(200);
});
