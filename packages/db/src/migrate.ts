import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  // migrations live two levels up from compiled src/: packages/db/drizzle
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = process.env.CRUMB_MIGRATIONS_DIR ?? resolve(here, "..", "drizzle");

  const conn = postgres(url, { max: 1, prepare: false });
  const db = drizzle(conn);

  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log("[migrate] done");
  await conn.end();
}

main().catch(err => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
