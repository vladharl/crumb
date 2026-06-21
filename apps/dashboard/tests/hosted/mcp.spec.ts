import { test, expect, type APIRequestContext } from "@playwright/test";
import { API_KEY } from "./fixtures";

// MCP server (app/api/mcp/route.ts) end-to-end against the live host, using a
// pre-provisioned API key. SAFE: we call the handshake + READ tools only. The
// write tools (update_item_status / reply_to_item / create_item / assign_item)
// would mutate real workspace data, so they are asserted to EXIST in the
// registry but never invoked.

const READ_TOOLS = ["list_items", "search_items", "get_item", "list_roadmap", "list_accounts"];
const WRITE_TOOLS = ["update_item_status", "reply_to_item", "create_item", "assign_item"];

let rpcId = 0;
async function rpc(request: APIRequestContext, key: string, method: string, params?: unknown) {
  const res = await request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  expect(res.ok(), `${method} HTTP ok`).toBeTruthy();
  return res.json();
}

test("MCP rejects a request with no bearer (401)", async ({ request }) => {
  const res = await request.post("/api/mcp", {
    headers: { "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toBe("Bearer");
  expect((await res.json()).error?.message).toBe("unauthorized");
});

test.describe("MCP with a valid API key", () => {
  test.beforeEach(() => {
    test.skip(!API_KEY, "no CRUMB_E2E_API_KEY — set it to a crumb_sk_… key from /settings/api-keys");
  });

  test("initialize → server identifies as crumb", async ({ request }) => {
    const init = await rpc(request, API_KEY!, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(init.result.serverInfo.name).toBe("crumb");
  });

  test("tools/list exposes the read + write tool registry", async ({ request }) => {
    const list = await rpc(request, API_KEY!, "tools/list");
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...READ_TOOLS, ...WRITE_TOOLS]));
  });

  test("read tools return well-formed results (no mutation)", async ({ request }) => {
    // list_items
    const items = await rpc(request, API_KEY!, "tools/call", { name: "list_items", arguments: { limit: 5 } });
    expect(items.result.isError, "list_items not an error").toBeFalsy();
    expect(typeof JSON.parse(items.result.content[0].text).count).toBe("number");

    // search_items (deliberately no-match query)
    const search = await rpc(request, API_KEY!, "tools/call", {
      name: "search_items",
      arguments: { query: "zzz_crumb_e2e_no_match_xyz", limit: 5 },
    });
    expect(search.result.isError, "search_items not an error").toBeFalsy();
    expect(typeof JSON.parse(search.result.content[0].text).count).toBe("number");

    // list_roadmap + list_accounts
    const roadmap = await rpc(request, API_KEY!, "tools/call", { name: "list_roadmap", arguments: {} });
    expect(roadmap.result.isError, "list_roadmap not an error").toBeFalsy();
    const accounts = await rpc(request, API_KEY!, "tools/call", { name: "list_accounts", arguments: { limit: 5 } });
    expect(accounts.result.isError, "list_accounts not an error").toBeFalsy();

    // get_item with a very unlikely short_id — callable + read-only; a
    // not_found tool-error is an acceptable, non-mutating outcome.
    const item = await rpc(request, API_KEY!, "tools/call", { name: "get_item", arguments: { short_id: "FB-000000" } });
    expect(typeof item.result.content[0].text, "get_item is callable").toBe("string");
  });
});
