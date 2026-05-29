// Pure ESM, runnable with plain `node` (no tsx). Used by the Docker entrypoint.
// The .ts variant in this folder exists for `pnpm db:migrate` against the same code
// path during dev.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
// In dev this file lives at packages/db/src/, in prod (esbuilt) it lives at packages/db/dist/.
// In both cases the migrations folder is at packages/db/drizzle/, i.e. one up.
const migrationsFolder =
  process.env.CRUMB_MIGRATIONS_DIR ?? resolve(here, "..", "drizzle");

const conn = postgres(url, { max: 1, prepare: false });
const db = drizzle(conn);

console.log(`[migrate] applying migrations from ${migrationsFolder}`);
try {
  await migrate(db, { migrationsFolder });
  console.log("[migrate] done");
  process.exit(0);
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exit(1);
} finally {
  await conn.end();
}
