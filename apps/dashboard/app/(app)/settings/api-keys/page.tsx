import { Card, CardHead, Pill } from "@crumb/ui";
import { and, desc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { db, apiKeys } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { ApiKeysPanel, type KeyView } from "./ApiKeysPanel";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { workspace, user } = await getActiveSession();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspace.id), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));

  const initial: KeyView[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));

  const origin = originFromHeaders(headers());
  const mcpUrl = `${origin ?? "https://your-crumb-host"}/api/mcp`;

  return (
    <>
      <Card>
        <CardHead title="API keys" after={<Pill ring>{rows.length} active</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
            API keys let an AI assistant connect to this workspace over MCP to read and triage your feedback. A key acts as the teammate who created it: writes (status changes, replies) are attributed to you and respect your role. Treat a key like a password.
          </p>
          <ApiKeysPanel initial={initial} isAdmin={user.role === "admin"} />
        </div>
      </Card>

      <Card>
        <CardHead title="Connect over MCP" />
        <div className="card-body col gap-3">
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
            Crumb exposes a Model Context Protocol server at the URL below. Point an MCP client (Claude Desktop, Cursor, or any MCP host) at it and authenticate with a key from above. The server offers tools to list and search feedback, read threads, change status, reply, create items, and view the roadmap.
          </p>
          <div className="code">{mcpUrl}</div>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            HTTP-capable clients (config):
          </p>
          <div className="code">
{`{
  "mcpServers": {
    "crumb": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer crumb_sk_…" }
    }
  }
}`}
          </div>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            For clients that only speak stdio, bridge with mcp-remote:
          </p>
          <div className="code">
{`npx mcp-remote ${mcpUrl} --header "Authorization: Bearer crumb_sk_…"`}
          </div>
        </div>
      </Card>
    </>
  );
}
