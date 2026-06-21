import { test, expect } from "@playwright/test";

// Endpoint-wiring + fail-closed checks for integration callbacks and webhook
// ingress. No session needed — these are unauthenticated negative tests that
// confirm each route is MOUNTED on the host and rejects bad/missing input
// BEFORE doing anything. None of them mutate data:
//   • OAuth callbacks with no code/state redirect back with an error flag
//     (they bail before any token exchange or DB write).
//   • Engineering webhooks (Linear/Jira/GitHub) 400 on a bad signature, before
//     the DB update.
//   • The customer-side integrations webhook 401s a malformed bearer (rejected
//     at JWT-parse, before any account write).

const REDIRECT_CODES = [301, 302, 303, 307, 308];

// provider → callback query key (the route redirects to ?<key>=error_missing_params)
const OAUTH_CALLBACKS: Array<{ key: string; queryKey: string }> = [
  { key: "slack", queryKey: "slack" },
  { key: "linear", queryKey: "linear" },
  { key: "jira", queryKey: "jira" },
  { key: "github", queryKey: "github" },
  { key: "hubspot", queryKey: "hubspot" },
  { key: "salesforce", queryKey: "salesforce" },
];

for (const { key, queryKey } of OAUTH_CALLBACKS) {
  test(`${key} callback: missing params → redirect back with error flag`, async ({ request }) => {
    const res = await request.get(`/api/integrations/${key}/callback`, { maxRedirects: 0 });
    expect(REDIRECT_CODES, `${key} callback should redirect`).toContain(res.status());
    const location = res.headers()["location"] ?? "";
    expect(location, `${key} callback redirects to settings`).toContain("/settings/integrations");
    expect(location, `${key} callback carries an error flag`).toContain(`${queryKey}=error`);
  });
}

// Engineering webhooks: header + raw-body HMAC. A bad/absent signature is
// rejected with 400 invalid_signature before the route looks at the body.
const WEBHOOKS: Array<{ key: string; sigHeader: string }> = [
  { key: "linear", sigHeader: "linear-signature" },
  { key: "jira", sigHeader: "x-hub-signature" },
  { key: "github", sigHeader: "x-hub-signature-256" },
];

for (const { key, sigHeader } of WEBHOOKS) {
  test(`${key} webhook: bad signature → 400 (no mutation)`, async ({ request }) => {
    const res = await request.post(`/api/integrations/${key}/webhook`, {
      headers: { [sigHeader]: "sha256=deadbeef", "content-type": "application/json" },
      data: { hello: "e2e" },
    });
    expect(res.status(), `${key} webhook rejects bad signature`).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });
}

test("customer integrations webhook: malformed bearer → 401", async ({ request }) => {
  // resolveCustomer → resolveFromJwt fails at parse → 401 invalid_token, before
  // any account row is touched. Edition-independent.
  const res = await request.post("/api/v1/account/integrations/webhook", {
    headers: { authorization: "Bearer not-a-jwt", "content-type": "application/json" },
    data: { provider: "slack", url: "https://hooks.example.com/x" },
  });
  expect(res.status()).toBe(401);
});
