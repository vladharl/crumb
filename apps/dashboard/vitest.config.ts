import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Unit tests for the dashboard's pure-function libs (jwt, rate-limit, AI
// prompt shaping, OAuth state HMAC, stripe helpers). Tests live under
// `tests/unit/`. E2E tests (under `tests/e2e/`) run via Playwright and are
// not picked up here.
//
// Two aliases are required:
//   1. `@/*` — mirrors the dashboard tsconfig's `paths` mapping. Inlined
//      here to avoid pulling in vite-tsconfig-paths (ESM-only, doesn't
//      load cleanly from a CJS vitest.config.ts).
//   2. `server-only` — Next.js's package that throws outside the server
//      context. Replaced with an empty module so unit tests can import
//      `lib/*` files directly.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: resolve(__dirname, "tests/unit/shims/server-only.ts") },
      { find: /^@\/(.*)$/, replacement: resolve(__dirname, "./$1") },
    ],
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
