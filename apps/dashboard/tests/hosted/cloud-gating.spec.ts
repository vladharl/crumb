import { test, expect } from "@playwright/test";
import { IS_CLOUD_EDITION } from "./fixtures";

// Cloud-only surfaces + the operator maintenance endpoint. No session needed.
//
// On the COMMUNITY build (default), the cloud-only routes are stripped at build
// time (scripts/apply-ee.mjs) so they 404 — verifying the edition gating worked.
// On a cloud-edition host (CRUMB_E2E_EDITION=cloud) they exist and instead
// reject unauthenticated/unsigned calls (4xx/410). Either way they must NOT 200
// an anonymous request.

const EE_ROUTES: Array<{ name: string; path: string; data?: unknown }> = [
  { name: "Stripe billing webhook", path: "/api/v1/stripe/webhook", data: {} },
  { name: "AI ask endpoint", path: "/api/v1/ask", data: { q: "e2e" } },
  // 32 hex chars — a syntactically-valid replay session id that doesn't exist.
  { name: "Session-record ingest", path: "/api/v1/replay-sessions/00000000000000000000000000000000/chunks", data: {} },
];

for (const r of EE_ROUTES) {
  test(`${r.name}: cloud-gated route is absent on community (or rejects on cloud)`, async ({ request }) => {
    const res = await request.post(r.path, {
      headers: { "content-type": "application/json" },
      data: r.data,
    });
    if (IS_CLOUD_EDITION) {
      // Present on cloud, but must reject an anonymous/unsigned call.
      expect(res.status(), `${r.name} should not 404 on cloud`).not.toBe(404);
      expect(res.status(), `${r.name} rejects anonymous`).toBeGreaterThanOrEqual(400);
    } else {
      expect(res.status(), `${r.name} stripped from community build`).toBe(404);
    }
  });
}

// Maintenance sweep (app/api/v1/internal/replay-sweep). Negative only — we never
// send the real CRUMB_INTERNAL_SWEEP_SECRET (that would run a destructive prune).
//   secret set on host + no/wrong header → 401; secret unset → 503.
const SWEEP_CODES = [401, 503];

test("replay-sweep: no secret header → unauthorized/unset", async ({ request }) => {
  const res = await request.post("/api/v1/internal/replay-sweep");
  expect(SWEEP_CODES).toContain(res.status());
});

test("replay-sweep: wrong secret header → unauthorized/unset", async ({ request }) => {
  const res = await request.post("/api/v1/internal/replay-sweep", {
    headers: { "x-crumb-sweep-secret": "crumb-e2e-definitely-wrong" },
  });
  expect(SWEEP_CODES).toContain(res.status());
});
