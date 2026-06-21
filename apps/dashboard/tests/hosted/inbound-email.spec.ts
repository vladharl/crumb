import { test, expect } from "@playwright/test";

// Inbound email webhooks: reply-by-email + forward-to-capture
// (app/api/v1/inbound/{reply,email}/route.ts). SAFE negative tests only — we
// send a payload whose `to` is NOT a valid signed Crumb address, with a bogus
// bearer, so the route rejects it BEFORE creating any reply or capture:
//   • if CRUMB_INBOUND_SECRET is set on the host → 401 unauthorized;
//   • if it's unset → 400 (no_reply_address / no_inbox_address),
// because the address never parses. Either way: a 4xx, and nothing is written.

const REJECT_CODES = [400, 401];

test("inbound reply: bad auth / unsigned address is rejected, no reply created", async ({ request }) => {
  const res = await request.post("/api/v1/inbound/reply", {
    headers: { authorization: "Bearer crumb-e2e-invalid", "content-type": "application/json" },
    data: { to: "someone@example.com", from: "customer@example.com", text: "e2e probe — should be rejected" },
  });
  expect(REJECT_CODES, "reply endpoint rejects").toContain(res.status());
  const body = await res.json().catch(() => ({}));
  expect(body.accepted, "no reply was accepted").not.toBe(true);
});

test("inbound capture: bad auth / unsigned address is rejected, no capture created", async ({ request }) => {
  const res = await request.post("/api/v1/inbound/email", {
    headers: { authorization: "Bearer crumb-e2e-invalid", "content-type": "application/json" },
    data: { to: "someone@example.com", from: "customer@example.com", subject: "e2e", text: "should be rejected" },
  });
  expect(REJECT_CODES, "capture endpoint rejects").toContain(res.status());
  const body = await res.json().catch(() => ({}));
  expect(body.captureId, "no capture was created").toBeFalsy();
});
