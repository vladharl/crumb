import { test, expect } from "@playwright/test";

// Session Record API auth surface, split by which side of the trust
// boundary the caller is on. The two describe blocks need *different*
// auth: the public ingest path must be exercised unauthenticated (it's
// the widget, cross-origin, token-only), while the vendor read path must
// carry the admin session cookie. `test.use` is scoped per-describe so the
// empty storageState for the public block doesn't leak into the vendor one.

test.describe("public ingest (unauthenticated)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // The dev server under CI has `CRUMB_TIER` unset (self_host default), so
  // this endpoint always 410s — Session Record is the one Cloud-only
  // capability where the data plane fails closed instead of degrading. We
  // pin it so a future `isCloud()` change can't silently open self-host to
  // recording it can't store.
  test("public replay ingest returns 410 on self-host", async ({ request }) => {
    const token = "0".repeat(32); // valid shape, but no session ever existed
    const res = await request.post(`/api/v1/replay-sessions/${token}/chunks`, {
      headers: { "content-type": "application/json" },
      data: {
        workspace_slug: "southbeam",
        sequence: 0,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        events: [{ type: 2, data: {}, timestamp: Date.now() }],
      },
    });
    expect(res.status()).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("session_record_cloud_only");
  });
});

test.describe("vendor reads (authenticated)", () => {
  // Inherits the project-default admin storageState (the seeded admin from
  // globalSetup). Workspace-scoped reads must refuse to leak content from a
  // missing or cross-tenant id rather than redirect/200.
  test("vendor-side manifest 404s for unknown ids", async ({ request }) => {
    const res = await request.get("/api/v1/replay-sessions/00000000-0000-0000-0000-000000000000/manifest");
    expect(res.status()).toBe(404);
  });
});
