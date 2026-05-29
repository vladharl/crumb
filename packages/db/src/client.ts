import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __crumbPg: ReturnType<typeof postgres> | undefined;
}

const url = process.env.DATABASE_URL ?? "postgres://crumb:crumb@localhost:5432/crumb";

// One postgres client per Node process; cached across HMR reloads in dev.
const client = globalThis.__crumbPg ?? postgres(url, { max: 8, prepare: false });
if (process.env.NODE_ENV !== "production") globalThis.__crumbPg = client;

export const db = drizzle(client, { schema });
export type DB = typeof db;
