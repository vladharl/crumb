import { NextResponse } from "next/server";
import { resolveApiKey, bearerFromRequest } from "@/lib/api-keys";
import { checkRateLimitAsync } from "@/lib/rate-limit";
import { originFromHeaders } from "@/lib/origin";
import { TOOLS, type ToolCtx } from "@/lib/mcp/tools";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// MCP server over Streamable HTTP, stateless. Each POST is one self-contained
// JSON-RPC 2.0 request and we answer with one JSON-RPC response (no SSE, no
// sessions, no Redis) — the right shape for a single-instance deploy. We
// implement the protocol directly rather than pulling an SDK so there's no
// zod-version / Next-version coupling to manage.
//
// Auth: Authorization: Bearer <crumb_sk_…> resolves to a workspace + actor
// (the key's creator) via lib/api-keys. Read tools need any valid key; write
// tools additionally require the actor's role to be admin/pm (enforced in the
// shared mutation cores). Rate-limited per key.

// Protocol revisions we speak, newest first. The server only implements
// initialize, ping and tools/*, whose shapes are the same in all three
// (2025-03-26's JSON-RPC batching is refused; 2025-06-18 dropped it).
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "crumb", version: "1.0.0" };

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result: value });
}
function error(id: JsonRpcId, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

// Stateless: we don't offer a server-initiated SSE stream, so GET/DELETE on the
// endpoint are not supported (per the Streamable HTTP spec, a 405 is valid).
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
export function DELETE() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

export async function POST(req: Request) {
  const key = await resolveApiKey(bearerFromRequest(req));
  if (!key) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "unauthorized" } },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  // Per-key token bucket (agents share egress IPs, so key — not IP — is the
  // right fingerprint). Inherits the Redis-optional / in-memory fallback.
  const rl = await checkRateLimitAsync(`mcp:${key.apiKeyId}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) {
    const res = error(null, INTERNAL_ERROR, "rate_limited", 429);
    res.headers.set("Retry-After", String(rl.retryAfterSeconds));
    return res;
  }

  let body: { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return error(null, PARSE_ERROR, "parse error", 400);
  }
  // 2025-06-18 dropped JSON-RPC batching.
  if (Array.isArray(body)) return error(null, INVALID_REQUEST, "batch not supported", 400);

  const id: JsonRpcId = (body?.id ?? null) as JsonRpcId;
  const method = typeof body?.method === "string" ? body.method : "";
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const isNotification = body?.id === undefined || body?.id === null;
  const ctx: ToolCtx = { ...key, origin: originFromHeaders(req.headers) };

  try {
    switch (method) {
      case "initialize":
        // Version negotiation: echo the client's revision when we speak it,
        // otherwise answer with our latest and let the client decide.
        return result(id, {
          protocolVersion: typeof params.protocolVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case "ping":
        return result(id, {});

      case "tools/list":
        return result(id, {
          tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });

      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) return error(id, INVALID_PARAMS, `unknown tool: ${name || "(none)"}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const out = await tool.handler(args, ctx);
          const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
          return result(id, { content: [{ type: "text", text }] });
        } catch (err) {
          // Tool-level failure (validation, not-found, forbidden) is reported as
          // isError content, not a transport error — the client/model sees it.
          const message = err instanceof Error ? err.message : String(err);
          return result(id, { content: [{ type: "text", text: message }], isError: true });
        }
      }

      default:
        // Lifecycle notifications (notifications/initialized, …) carry no id and
        // expect no body. Any other unknown notification is also just acked.
        if (isNotification) return new NextResponse(null, { status: 202 });
        return error(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  } catch (err) {
    log.error("mcp request failed", { scope: "crumb/mcp", method, err });
    if (isNotification) return new NextResponse(null, { status: 202 });
    return error(id, INTERNAL_ERROR, "internal error");
  }
}
