import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, apiKeys, items, workspaces, workspaceUsers } from "@crumb/db";
import { newApiKey } from "@/lib/api-keys";
import { likeContains } from "@/lib/like";
import { POST } from "@/app/api/mcp/route";

// The MCP endpoint end to end against Postgres (DATABASE_URL, migrated):
// version negotiation, literal % and _ in search, and keyset pages that don't
// skip rows created in the same millisecond. Skipped locally when no database
// answers; CI has one, so there it fails instead of skipping.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const tag = randomUUID().slice(0, 8);
let workspaceId = "";
let key = "";

async function rpc(method: string, params?: unknown) {
  const res = await POST(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  return res.json();
}

async function call(name: string, args: Record<string, unknown>) {
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  return r.isError ? { error: r.content[0].text as string } : JSON.parse(r.content[0].text);
}

describe.skipIf(!reachable && !process.env.CI)("MCP route", () => {
  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `mcp-${tag}`, name: "MCP test" }).returning({ id: workspaces.id });
    workspaceId = ws.id;
    const [admin] = await db.insert(workspaceUsers)
      .values({ workspaceId, email: `admin-${tag}@crumb.test`, name: "Ada", initials: "A", role: "admin" })
      .returning({ id: workspaceUsers.id });
    const k = newApiKey();
    await db.insert(apiKeys).values({ workspaceId, createdByWorkspaceUserId: admin.id, name: "test", tokenHash: k.hash, prefix: k.prefix });
    key = k.raw;

    const [acct] = await db.insert(accounts).values({ workspaceId, name: "Acme", arrCents: 4_800_000 }).returning({ id: accounts.id });
    await db.insert(accounts).values({ workspaceId, name: "Globex", arrCents: 5_000_000_000 });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    // Three items inside one millisecond, a microsecond apart.
    const titles = ["a_b toggle", "500 off", "50% off"];
    await db.insert(items).values(titles.map((title, i) => ({
      workspaceId, accountId: acct.id, submitterId: pat.id, seq: i + 1, shortId: `FB-${i + 1}`, title, type: "idea",
      createdAt: sql`${`2026-01-01 00:00:00.00010${i}+00`}::timestamptz`,
    })));
  });

  afterAll(async () => {
    if (!workspaceId) return;
    await db.delete(items).where(eq(items.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("answers initialize with a version it supports", async () => {
    expect((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion).toBe("2025-03-26");
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-06-18");
    expect((await rpc("initialize", {})).result.protocolVersion).toBe("2025-06-18");
  });

  it("search treats % and _ as literal characters", async () => {
    expect(likeContains("50%_\\")).toBe("%50\\%\\_\\\\%");
    const titles = async (query: string) => (await call("search_items", { query })).items.map((i: { title: string }) => i.title);
    expect(await titles("50%")).toEqual(["50% off"]);
    expect(await titles("_")).toEqual(["a_b toggle"]);
  });

  it("pages with a cursor without skipping or repeating rows", async () => {
    const first = await call("list_items", { limit: 2 });
    expect(first.items.map((i: { short_id: string }) => i.short_id)).toEqual(["FB-3", "FB-2"]);
    expect(first.items[0]).not.toHaveProperty("_key");
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await call("list_items", { limit: 2, cursor: first.next_cursor });
    expect(second.items.map((i: { short_id: string }) => i.short_id)).toEqual(["FB-1"]);
    expect(second.next_cursor).toBeNull();

    expect(await call("list_items", { cursor: "not-a-cursor" })).toEqual({ error: "invalid_cursor" });

    const top = await call("list_accounts", { limit: 1 });
    expect(top.accounts.map((a: { name: string }) => a.name)).toEqual(["Globex"]);
    const rest = await call("list_accounts", { limit: 1, cursor: top.next_cursor });
    expect(rest.accounts.map((a: { name: string }) => a.name)).toEqual(["Acme"]);
    expect(rest.next_cursor).toBeNull();
  });
});
