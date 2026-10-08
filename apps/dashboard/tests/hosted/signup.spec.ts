import { test, expect } from "@playwright/test";
import { IS_CLOUD_EDITION } from "./fixtures";

// Self-serve signup surface (Cloud-only; stripped on community builds).
// SAFE OPS ONLY — like the rest of the hosted suite, these never create a
// workspace: the page GET is read-only, and the verify check is a GET, which
// only forwards to /signup?token=… (only the Create button's POST provisions).
//
// On community the /signup route is stripped at build time (404). On cloud it
// exists: the page either renders (tier=cloud) or redirects to /onboard
// (tier=self_host) — either way NOT 404 and NOT a server error.

test("signup page: stripped on community, present on cloud", async ({ request }) => {
  const res = await request.get("/signup", { maxRedirects: 0 });
  if (IS_CLOUD_EDITION) {
    expect(res.status(), "/signup should not 404 on cloud").not.toBe(404);
    expect(res.status(), "/signup should not 5xx").toBeLessThan(500);
  } else {
    expect(res.status(), "/signup stripped from community build").toBe(404);
  }
});

test("signup verify: bogus token redirects back to /signup without provisioning", async ({ request }) => {
  const res = await request.get("/signup/verify?token=definitely-not-a-real-token", { maxRedirects: 0 });
  if (IS_CLOUD_EDITION) {
    // Must reject by redirecting to the signup page — never 200, never 404.
    expect(res.status(), "verify redirects").toBeGreaterThanOrEqual(300);
    expect(res.status(), "verify redirects").toBeLessThan(400);
    expect(res.headers()["location"] ?? "", "redirects to /signup").toContain("/signup");
  } else {
    expect(res.status(), "verify stripped from community build").toBe(404);
  }
});
