// ILIKE reads % and _ as wildcards and \ as its escape: match them literally.
// Shared by the MCP tools and the ⌘K palette route; its own module so the
// route doesn't pull in lib/mcp/tools.
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}
