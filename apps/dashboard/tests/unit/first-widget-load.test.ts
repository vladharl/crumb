import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, workspaces } from "@crumb/db";
import { sign } from "@/lib/jwt";
import { resolveCustomer } from "@/lib/public-api";

// A brand-new customer's first widget load (and the Install page's first "Try
// it" preview) boots /api/v1/me and /api/v1/items at once, and both create
// the customer on first contact. They must resolve to one account and one user
// (the account's admin), with no request failing on the race.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("first widget load", () => {
  afterAll(async () => {
    if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("concurrent first requests for a new customer make one account and one user", async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `first-load-${tag}`, name: "First load test" })
      .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
    created.push(ws.id);
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ iss: ws.slug, sub: `pat@${tag}.test`, name: "Pat Lee", account_name: "Initech", iat: now, exp: now + 600 }, ws.secret);
    const firstLoad = () => resolveCustomer(new Request("http://localhost/api/v1/me", { headers: { authorization: `Bearer ${token}` } }));
    // Open every pooled connection first, as on a running server; a cold pool
    // staggers the requests behind connection setup and hides the race.
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`select pg_sleep(0.05)`)));

    const results = await Promise.all(Array.from({ length: 6 }, firstLoad));

    expect(results.map(r => r.ok)).toEqual(Array(6).fill(true));
    expect(new Set(results.map(r => r.ok && r.ctx.user.id)).size).toBe(1);
    expect(await db.select().from(accounts).where(eq(accounts.workspaceId, ws.id))).toHaveLength(1);
    const users = await db.select().from(accountUsers).where(eq(accountUsers.workspaceId, ws.id));
    expect(users.map(u => [u.email, u.role])).toEqual([[`pat@${tag}.test`, "admin"]]);
  });
});
