import { test, expect, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";

// End-to-end for the MCP server + the central event system. We:
//   1. Mint an API key through the settings UI (capturing the once-shown raw key).
//   2. Drive the MCP JSON-RPC endpoint with that key (initialize → tools/list →
//      a read tool → a write tool).
//   3. Register a webhook subscribed to item.status_changed pointing at an
//      in-process receiver, then change status via MCP and assert the event
//      was delivered — proving the write core fans out events.
//
// The e2e webServer runs in self_host tier (playwright.config.ts), where the
// outbound-webhook SSRF guard (isDeliverableUrl) allows localhost — so the
// in-process receiver below can receive a real delivery.

const PORT = 3941;
let server: Server;
const received: Array<{ event: string; body: string }> = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ event: req.headers["x-crumb-event"] as string ?? "", body: b });
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let rpcId = 0;
async function rpc(request: APIRequestContext, key: string, method: string, params?: unknown) {
  const res = await request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test("MCP key mints, tools work, and a status write fans out an event", async ({ page, request }) => {
  // 1. Mint a key via the UI and capture the raw value (shown once).
  await page.goto("/settings/api-keys");
  await page.getByPlaceholder(/Key name/i).fill("e2e-mcp");
  await page.getByRole("button", { name: /Create key/i }).click();
  const rawLoc = page.locator("text=/crumb_sk_/").first();
  await expect(rawLoc).toBeVisible({ timeout: 10_000 });
  const key = (await rawLoc.textContent())!.trim();
  expect(key.startsWith("crumb_sk_")).toBeTruthy();

  // 2a. initialize handshake.
  const init = await rpc(request, key, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  expect(init.result.serverInfo.name).toBe("crumb");

  // 2b. tools/list includes our read + write tools.
  const list = await rpc(request, key, "tools/list");
  const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["list_items", "get_item", "update_item_status", "reply_to_item"]));

  // 2c. a read tool returns workspace items.
  const listed = await rpc(request, key, "tools/call", { name: "list_items", arguments: { limit: 5 } });
  expect(listed.result.isError).toBeFalsy();
  const payload = JSON.parse(listed.result.content[0].text);
  expect(payload.count).toBeGreaterThan(0);

  // 3. Register a webhook (default subscription includes item.status_changed).
  await page.goto("/settings/webhooks");
  await page.getByPlaceholder(/your-app\.example\.com/i).fill(`http://localhost:${PORT}/hook`);
  await page.getByRole("button", { name: /Add endpoint/i }).click();
  await expect(page.getByText(/Save this signing secret/i)).toBeVisible({ timeout: 10_000 });

  // Pick a target status different from the item's current one (other specs
  // share the seeded fixture, so don't assume FB-247's starting status).
  const before = await rpc(request, key, "tools/call", { name: "get_item", arguments: { short_id: "FB-247" } });
  const current = JSON.parse(before.result.content[0].text).item.status as string;
  const target = current === "planned" ? "review" : "planned";

  // 3b. change status via the MCP write tool.
  const changed = await rpc(request, key, "tools/call", {
    name: "update_item_status",
    arguments: { short_id: "FB-247", status: target },
  });
  expect(changed.result.isError).toBeFalsy();
  expect(JSON.parse(changed.result.content[0].text).status).toBe(target);

  // 3c. the change is visible on a subsequent read.
  const after = await rpc(request, key, "tools/call", { name: "get_item", arguments: { short_id: "FB-247" } });
  expect(JSON.parse(after.result.content[0].text).item.status).toBe(target);

  // 3d. the event reached the webhook receiver.
  await expect
    .poll(() => received.find((r) => r.event === "item.status_changed")?.body ?? "", { timeout: 15_000 })
    .toContain("FB-247");
});
