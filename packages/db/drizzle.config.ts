import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "postgres://crumb:crumb@localhost:5432/crumb";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
});
