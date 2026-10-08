import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __crumbPg: ReturnType<typeof postgres> | undefined;
}

// NAME, or when it's empty, the contents of the file NAME_FILE names (the
// Docker / Kubernetes secrets convention), as docker-entrypoint.sh resolves it
// for the server. Operator commands run with `docker compose exec` skip the
// entrypoint, so they need it resolved here.
export function envOrFile(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  return !process.env[name] && file ? readFileSync(file, "utf8").trim() : process.env[name];
}

const url = envOrFile("DATABASE_URL") ?? "postgres://crumb:crumb@localhost:5432/crumb";

// One postgres client per Node process; cached across HMR reloads in dev.
const client = globalThis.__crumbPg ?? postgres(url, { max: 8, prepare: false });
if (process.env.NODE_ENV !== "production") globalThis.__crumbPg = client;

export const db = drizzle(client, { schema });
export type DB = typeof db;
