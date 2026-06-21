import { test, expect } from "@playwright/test";

// Liveness + readiness probes (lib: app/api/health/route.ts + ready/route.ts).
// No auth. These are the baseline "is the deployment actually up and serving,
// with the DB reachable" checks — every other spec assumes they pass.

test("liveness: GET /api/health → 200 {ok:true}", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("readiness: GET /api/health/ready → 200 {ok:true,db:'up'}", async ({ request }) => {
  const res = await request.get("/api/health/ready");
  // 503 here means the host can't reach Postgres — a real finding, so we fail.
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, db: "up" });
});
