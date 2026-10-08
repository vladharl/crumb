import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, workspaces } from "@crumb/db";
import { GET, POST } from "@/app/api/v1/unsubscribe/route";

// Corporate link scanners open every link in an email, so the unsubscribe link
// must only ask on GET. The preference changes on the Confirm POST or an
// RFC 8058 one-click POST from the inbox, and Undo puts it back.
//
// Runs the real route against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`). Skipped locally when no database answers; CI has one,
// so there it fails instead of skipping.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

async function customer() {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `unsub-${randomUUID().slice(0, 8)}`, name: "Acme <Labs>" })
    .returning({ id: workspaces.id });
  created.push(ws.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Initech" }).returning({ id: accounts.id });
  const [user] = await db.insert(accountUsers)
    .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@initech.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id, token: accountUsers.unsubToken });
  return user;
}

async function prefs(id: string) {
  const [row] = await db
    .select({ all: accountUsers.unsubscribedAll, status: accountUsers.notifyStatus })
    .from(accountUsers)
    .where(eq(accountUsers.id, id));
  return row;
}

const link = (u: { id: string; token: string }, scope: string) =>
  `http://localhost/api/v1/unsubscribe?u=${u.id}&t=${u.token}&scope=${scope}`;
const post = (href: string, form: Record<string, string>) =>
  POST(new Request(href, { method: "POST", body: new URLSearchParams(form) }));

describe.skipIf(!reachable && !process.env.CI)("unsubscribe link", () => {
  afterAll(async () => {
    if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("GET only asks; Confirm unsubscribes; Undo restores", async () => {
    const u = await customer();
    const href = link(u, "status");

    const ask = await GET(new Request(href));
    const html = await ask.text();
    expect(ask.status).toBe(200);
    expect(html).toContain("Acme &#60;Labs&#62; will stop emailing you when your feedback changes status.");
    expect(html).toContain("Confirm");
    expect(await prefs(u.id)).toEqual({ all: false, status: true });

    const done = await post(href, { action: "unsubscribe" });
    expect(await done.text()).toContain("Undo");
    expect(await prefs(u.id)).toEqual({ all: false, status: false });

    await post(href, { action: "resubscribe" });
    expect(await prefs(u.id)).toEqual({ all: false, status: true });
  });

  it("accepts the RFC 8058 one-click POST without a page", async () => {
    const u = await customer();
    const res = await post(link(u, "all"), { "List-Unsubscribe": "One-Click" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(await prefs(u.id)).toEqual({ all: true, status: true });
  });

  it("a wrong token or unknown scope changes nothing", async () => {
    const u = await customer();
    const forged = await post(link({ id: u.id, token: "0".repeat(64) }, "all"), { "List-Unsubscribe": "One-Click" });
    expect(forged.status).toBe(400);
    expect((await GET(new Request(link(u, "constructor")))).status).toBe(400);
    expect(await prefs(u.id)).toEqual({ all: false, status: true });
  });
});
