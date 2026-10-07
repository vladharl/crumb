import "server-only";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db, items, accounts, accountUsers, replies, statusEvents, initiatives, workspaceUsers, workspaces,
} from "@crumb/db";
import type { ResolvedApiKey } from "@/lib/api-keys";
import {
  updateItemStatus, createItemReply, assignItemTo,
  ALLOWED_STATUSES, type Status, type VendorActor,
} from "@/lib/items/mutations";
import { composeItem, COMPOSE_ALLOWED_TYPES } from "@/lib/compose";

// MCP tool registry. Each tool is a JSON-RPC-callable function exposed to a
// connected AI client (Claude/Cursor) over the /api/mcp endpoint. Read tools
// query the workspace's feedback; write tools delegate to the shared cores in
// lib/items/mutations.ts so events + notifications fire exactly as they do from
// the dashboard. EVERY query is scoped to ctx.workspaceId — the key's tenant.

export type ToolCtx = ResolvedApiKey & { origin: string | null };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
};

const ITEM_TYPES = ["bug", "idea", "question"] as const;
const LIMIT_MAX = 200;

function actorOf(ctx: ToolCtx): VendorActor {
  return { workspaceId: ctx.workspaceId, actorWorkspaceUserId: ctx.actorWorkspaceUserId, role: ctx.role };
}

function clampLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), LIMIT_MAX);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Throwing surfaces as an MCP tool error (isError content) — the route catches it.
function fail(msg: string): never {
  throw new Error(msg);
}

// Unwrap a core mutation result, throwing its error code on failure.
function unwrap<T extends { ok: true } | { ok: false; error: string }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) fail(r.error);
  return r as Extract<T, { ok: true }>;
}

// ILIKE reads % and _ as wildcards and \ as its escape: match them literally.
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

// Keyset pages for the capped list tools. `next_cursor` names the last row
// returned by its integer sort key and id; passing it back as `cursor` resumes
// strictly after that row, so rows created meanwhile can't shift or repeat a
// page. Opaque to clients: base64url of "<key>:<uuid>".
const CURSOR_RE = /^(-?\d{1,19}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function readCursor(v: unknown): { key: string; id: string } | null {
  const raw = str(v);
  if (!raw) return null;
  const m = CURSOR_RE.exec(Buffer.from(raw, "base64url").toString("utf8"));
  return m ? { key: m[1]!, id: m[2]! } : fail("invalid_cursor");
}

// Callers fetch limit + 1 rows, so a full page knows whether more remain.
function page<T extends { _key: string; _id: string }>(rows: T[], limit: number) {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    rows: kept.map(({ _key, _id, ...row }) => row),
    next_cursor: rows.length > limit && last ? Buffer.from(`${last._key}:${last._id}`).toString("base64url") : null,
  };
}

// Item sort key: created_at in integer microseconds, the precision Postgres
// stores. A JS Date keeps only milliseconds, so a cursor built from one would
// skip rows created later in the same millisecond.
const CREATED_US = sql`(extract(epoch from ${items.createdAt}) * 1000000)::bigint`;
const itemsAfter = (c: { key: string; id: string }) =>
  sql`(${CREATED_US}, ${items.id}) < (${c.key}::bigint, ${c.id}::uuid)`;

const CURSOR_PROP = { type: "string", description: "next_cursor from the previous call, to fetch the next page." };

export const TOOLS: ToolDef[] = [
  // ─── read ──────────────────────────────────────────────────
  {
    name: "list_items",
    description:
      "List feedback items in the workspace, newest first. Optionally filter by status, type, or account name. Returns short_id, title, type, status, account, and timestamps, plus next_cursor when more items remain (pass it back as cursor for the next page).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...ALLOWED_STATUSES], description: "Filter by status." },
        type: { type: "string", enum: [...ITEM_TYPES], description: "Filter by item type." },
        account: { type: "string", description: "Exact account name to filter by." },
        limit: { type: "integer", description: "Max rows (default 50, max 200)." },
        cursor: CURSOR_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const conds = [eq(items.workspaceId, ctx.workspaceId)];
      const status = str(args.status);
      if (status) conds.push(eq(items.status, status));
      const type = str(args.type);
      if (type) conds.push(eq(items.type, type));
      const account = str(args.account);
      if (account) conds.push(eq(accounts.name, account));
      const after = readCursor(args.cursor);
      if (after) conds.push(itemsAfter(after));
      const limit = clampLimit(args.limit, 50);

      const rows = await db
        .select({
          short_id: items.shortId,
          title: items.title,
          type: items.type,
          status: items.status,
          account: accounts.name,
          created_at: items.createdAt,
          updated_at: items.updatedAt,
          _key: sql<string>`${CREATED_US}::text`,
          _id: items.id,
        })
        .from(items)
        .innerJoin(accounts, eq(accounts.id, items.accountId))
        .where(and(...conds))
        .orderBy(desc(items.createdAt), desc(items.id))
        .limit(limit + 1);
      const p = page(rows, limit);
      return { count: p.rows.length, items: p.rows, next_cursor: p.next_cursor };
    },
  },
  {
    name: "search_items",
    description: "Full-text-ish search over feedback item titles and bodies (case-insensitive substring; % and _ match literally). Returns matching items newest first, plus next_cursor when more remain (pass it back as cursor for the next page).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in title/body." },
        limit: { type: "integer", description: "Max rows (default 25, max 200)." },
        cursor: CURSOR_PROP,
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const q = str(args.query) ?? fail("query is required");
      const like = likeContains(q);
      const conds = [eq(items.workspaceId, ctx.workspaceId), or(ilike(items.title, like), ilike(items.body, like))];
      const after = readCursor(args.cursor);
      if (after) conds.push(itemsAfter(after));
      const limit = clampLimit(args.limit, 25);

      const rows = await db
        .select({
          short_id: items.shortId,
          title: items.title,
          type: items.type,
          status: items.status,
          account: accounts.name,
          created_at: items.createdAt,
          _key: sql<string>`${CREATED_US}::text`,
          _id: items.id,
        })
        .from(items)
        .innerJoin(accounts, eq(accounts.id, items.accountId))
        .where(and(...conds))
        .orderBy(desc(items.createdAt), desc(items.id))
        .limit(limit + 1);
      const p = page(rows, limit);
      return { count: p.rows.length, items: p.rows, next_cursor: p.next_cursor };
    },
  },
  {
    name: "get_item",
    description: "Fetch one feedback item by short_id with its full thread: the body, all replies (including internal notes), and the status timeline.",
    inputSchema: {
      type: "object",
      properties: { short_id: { type: "string", description: "The item short id, e.g. FB-42." } },
      required: ["short_id"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const shortId = str(args.short_id) ?? fail("short_id is required");
      const [row] = await db
        .select({
          id: items.id,
          short_id: items.shortId,
          title: items.title,
          body: items.body,
          type: items.type,
          status: items.status,
          account: accounts.name,
          submitter: accountUsers.name,
          submitter_email: accountUsers.email,
          assignee: workspaceUsers.name,
          created_at: items.createdAt,
          updated_at: items.updatedAt,
        })
        .from(items)
        .innerJoin(accounts, eq(accounts.id, items.accountId))
        .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
        .leftJoin(workspaceUsers, eq(workspaceUsers.id, items.assigneeId))
        .where(and(eq(items.workspaceId, ctx.workspaceId), eq(items.shortId, shortId)))
        .limit(1);
      if (!row) fail("not_found");
      const { id: itemId, ...item } = row;

      const msgs = await db
        .select({
          body: replies.body,
          internal: replies.internal,
          vendor: workspaceUsers.name,
          customer: accountUsers.name,
          created_at: replies.createdAt,
        })
        .from(replies)
        .leftJoin(workspaceUsers, eq(workspaceUsers.id, replies.workspaceUserId))
        .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
        .where(eq(replies.itemId, itemId))
        .orderBy(asc(replies.createdAt));

      const timeline = await db
        .select({
          from_status: statusEvents.fromStatus,
          to_status: statusEvents.toStatus,
          reason: statusEvents.reason,
          by: workspaceUsers.name,
          at: statusEvents.at,
        })
        .from(statusEvents)
        .leftJoin(workspaceUsers, eq(workspaceUsers.id, statusEvents.byWorkspaceUserId))
        .where(eq(statusEvents.itemId, itemId))
        .orderBy(asc(statusEvents.at));

      return {
        item,
        replies: msgs.map(m => ({
          author: m.vendor ?? m.customer ?? "—",
          kind: m.vendor ? "vendor" : "customer",
          internal: m.internal,
          body: m.body,
          created_at: m.created_at,
        })),
        timeline,
      };
    },
  },
  {
    name: "list_roadmap",
    description: "List the workspace's roadmap initiatives grouped by column (now / next / later) plus any unscheduled ones. Returns name, status, description, and visibility.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const rows = await db
        .select({
          short_id: initiatives.shortId,
          name: initiatives.name,
          description: initiatives.description,
          status: initiatives.status,
          column: initiatives.roadmapColumn,
          is_public: initiatives.isPublic,
        })
        .from(initiatives)
        .where(eq(initiatives.workspaceId, ctx.workspaceId))
        .orderBy(asc(initiatives.roadmapOrder));
      const group = (col: string) => rows.filter(r => r.column === col);
      return { now: group("now"), next: group("next"), later: group("later"), unscheduled: rows.filter(r => !r.column) };
    },
  },
  {
    name: "list_accounts",
    description: "List customer accounts in the workspace with their ARR (US dollars) and start date, highest ARR first, plus next_cursor when more remain (pass it back as cursor for the next page).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max rows (default 100, max 200)." },
        cursor: CURSOR_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const conds = [eq(accounts.workspaceId, ctx.workspaceId)];
      const after = readCursor(args.cursor);
      if (after) conds.push(sql`(${accounts.arrCents}, ${accounts.id}) < (${after.key}::bigint, ${after.id}::uuid)`);
      const limit = clampLimit(args.limit, 100);

      const rows = await db
        .select({
          name: accounts.name,
          arr_cents: accounts.arrCents,
          since: accounts.since,
          _key: sql<string>`${accounts.arrCents}::text`,
          _id: accounts.id,
        })
        .from(accounts)
        .where(and(...conds))
        .orderBy(desc(accounts.arrCents), desc(accounts.id))
        .limit(limit + 1);
      const p = page(rows, limit);
      return {
        count: p.rows.length,
        accounts: p.rows.map(r => ({ name: r.name, arr_usd: r.arr_cents / 100, since: r.since })),
        next_cursor: p.next_cursor,
      };
    },
  },

  // ─── write (require admin/pm — enforced in the cores) ──────
  {
    name: "update_item_status",
    description:
      "Change a feedback item's status. Allowed: open, review, planned, progress, shipped, declined, deferred, duplicate. A reason is required for declined/deferred/duplicate. Fires webhooks just like the dashboard. Only planned, progress, shipped, declined (won't ship) and deferred (set aside) email the submitter, and only when they can be emailed: they submitted through the widget, have an address, haven't opted out, and the workspace has email delivery set up. `emailed` in the result says whether that email actually went out.",
    inputSchema: {
      type: "object",
      properties: {
        short_id: { type: "string", description: "The item short id, e.g. FB-42." },
        status: { type: "string", enum: [...ALLOWED_STATUSES] },
        reason: { type: "string", description: "Required for declined/deferred/duplicate." },
      },
      required: ["short_id", "status"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const shortId = str(args.short_id) ?? fail("short_id is required");
      const status = str(args.status) ?? fail("status is required");
      const r = unwrap(await updateItemStatus(actorOf(ctx), {
        itemShortId: shortId,
        status: status as Status,
        reason: str(args.reason) ?? undefined,
        origin: ctx.origin,
      }));
      return { ok: true, short_id: shortId, status, emailed: r.emailed };
    },
  },
  {
    name: "reply_to_item",
    description:
      "Post a reply on a feedback item. By default it's a customer-facing reply: it fires webhooks, and emails the submitter only when they can be emailed (they submitted through the widget, have an address, haven't opted out, and the workspace has email delivery set up). `emailed` in the result says whether that email actually went out. Set internal=true for a private team note, which never emails.",
    inputSchema: {
      type: "object",
      properties: {
        short_id: { type: "string" },
        body: { type: "string" },
        internal: { type: "boolean", description: "Private team note (default false)." },
      },
      required: ["short_id", "body"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const shortId = str(args.short_id) ?? fail("short_id is required");
      const body = str(args.body) ?? fail("body is required");
      const r = unwrap(await createItemReply(actorOf(ctx), {
        itemShortId: shortId,
        body,
        internal: args.internal === true,
        origin: ctx.origin,
      }));
      return { ok: true, short_id: shortId, reply_id: r.replyId, internal: args.internal === true, emailed: r.emailed };
    },
  },
  {
    name: "create_item",
    description:
      "Create a feedback item on behalf of a customer. Upserts the account + submitter by name/email. Type must be bug, idea, or question.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Customer account name." },
        submitter_email: { type: "string", description: "Submitter's email." },
        type: { type: "string", enum: [...ITEM_TYPES] },
        title: { type: "string" },
        body: { type: "string" },
        submitter_name: { type: "string" },
      },
      required: ["account", "submitter_email", "type", "title"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const account = str(args.account) ?? fail("account is required");
      const submitterEmail = str(args.submitter_email) ?? fail("submitter_email is required");
      const type = str(args.type) ?? fail("type is required");
      const title = str(args.title) ?? fail("title is required");
      if (!COMPOSE_ALLOWED_TYPES.has(type)) fail("bad_type");
      // Manage gate: creating items is a write — viewers can't.
      if (ctx.role !== "admin" && ctx.role !== "pm") fail("forbidden");

      const [ws] = await db
        .select({ id: workspaces.id, planId: workspaces.planId, subscriptionStatus: workspaces.subscriptionStatus })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId))
        .limit(1);

      const r = unwrap(await composeItem({
        workspaceId: ctx.workspaceId,
        accountName: account,
        submitterEmail,
        submitterName: str(args.submitter_name) ?? undefined,
        type,
        title,
        body: str(args.body) ?? undefined,
        workspace: ws ?? undefined,
      }));
      return { ok: true, short_id: r.shortId, account: r.accountName };
    },
  },
  {
    name: "assign_item",
    description:
      "Assign a feedback item to a workspace teammate by email, or unassign it. Omit assignee_email (or pass it empty) to unassign.",
    inputSchema: {
      type: "object",
      properties: {
        short_id: { type: "string" },
        assignee_email: { type: "string", description: "Teammate email, or omit to unassign." },
      },
      required: ["short_id"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const shortId = str(args.short_id) ?? fail("short_id is required");
      let assigneeId: string | null = null;
      const email = str(args.assignee_email);
      if (email) {
        const [m] = await db
          .select({ id: workspaceUsers.id })
          .from(workspaceUsers)
          .where(and(eq(workspaceUsers.workspaceId, ctx.workspaceId), eq(workspaceUsers.email, email.toLowerCase())))
          .limit(1);
        if (!m) fail("assignee_not_found");
        assigneeId = m.id;
      }
      unwrap(await assignItemTo(actorOf(ctx), { itemShortId: shortId, assigneeId }));
      return { ok: true, short_id: shortId, assignee_email: email ?? null };
    },
  },
];
