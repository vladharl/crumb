import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Self-host config guards. The dashboard service used to pass env through an
// explicit allowlist, so settings documented in .env (SMTP_SECURE, rate
// limits, key rotation, replay retention, ...) silently never reached the
// container. And uploads defaulted to the container's own disk, which every
// upgrade recreates, deleting them. Both fixes are one line of YAML each.
const compose = readFileSync(resolve(__dirname, "../../../../docker-compose.yml"), "utf8");
const dashboard = compose.slice(compose.indexOf("\n  dashboard:"), compose.indexOf("\n  cloudflared:"));

describe("docker-compose dashboard service", () => {
  it("passes every .env variable to the container, and still starts without a .env", () => {
    expect(dashboard).toMatch(/env_file:\n\s+- path: \.env\n\s+required: false\n/);
  });

  it("keeps uploads in Postgres unless the operator picks another provider", () => {
    expect(dashboard).toContain("CRUMB_STORAGE_PROVIDER: ${CRUMB_STORAGE_PROVIDER:-postgres}");
  });
});
