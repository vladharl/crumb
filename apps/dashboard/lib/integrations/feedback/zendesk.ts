import "server-only";
import type { IntegrationConnection } from "@crumb/db";
import { open } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";
import { type FeedbackAdapter, type FeedbackPage, type FeedbackRecord, readConfig, lookbackStart, vendorSubdomain } from "./types";

// Zendesk Support — Incremental Ticket Export.
//   https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/
// Auth: HTTP Basic with "<agent-email>/token:<api-token>". The api token is the
// connection's sealed accessToken; the agent email + subdomain live in config.
// Cursor: the export's unix `end_time`; we sideload requester users to recover
// the submitter email so the gate can map an account / auto-promote.

const PAGE_LIMIT = 100;

type ZendeskUser = { id: number; email?: string | null; name?: string | null };
type ZendeskTicket = {
  id: number;
  subject?: string | null;
  description?: string | null;
  requester_id?: number | null;
  updated_at?: string | null;
  status?: string | null;
};
type ExportResponse = {
  tickets?: ZendeskTicket[];
  users?: ZendeskUser[];
  end_time?: number | null;
  end_of_stream?: boolean;
};

export const zendesk: FeedbackAdapter = {
  provider: "zendesk",

  configured() {
    return true; // BYO subdomain + agent email + API token on the connection
  },

  async listSince(conn: IntegrationConnection, cursor: string | null): Promise<FeedbackPage> {
    const cfg = readConfig(conn);
    const token = conn.accessToken ? open(conn.accessToken) : null;
    if (!cfg.subdomain || !cfg.email || !token) {
      log.error("zendesk connection incomplete", { scope: "crumb/zendesk", workspaceId: conn.workspaceId });
      return { records: [], nextCursor: cursor, done: true };
    }
    const sub = vendorSubdomain(cfg.subdomain);
    if (!sub) throw new Error('Invalid Zendesk subdomain. Enter just the "acme" of acme.zendesk.com.');

    const startTime = cursor ? Number(cursor) : Math.floor(lookbackStart().getTime() / 1000);
    const url = new URL(`https://${sub}.zendesk.com/api/v2/incremental/tickets.json`);
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("include", "users");
    url.searchParams.set("per_page", String(PAGE_LIMIT));

    const auth = Buffer.from(`${cfg.email}/token:${token}`).toString("base64");
    const resp = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" }, redirect: "manual" });
    if (!resp.ok) {
      log.error("zendesk incremental export failed", { scope: "crumb/zendesk", status: resp.status });
      return { records: [], nextCursor: cursor, done: true };
    }
    const data = (await resp.json()) as ExportResponse;

    const emailById = new Map<number, { email: string | null; name: string | null }>();
    for (const u of data.users ?? []) emailById.set(u.id, { email: u.email ?? null, name: u.name ?? null });

    const records: FeedbackRecord[] = [];
    for (const t of data.tickets ?? []) {
      const requester = t.requester_id != null ? emailById.get(t.requester_id) : undefined;
      const text = [t.subject, t.description].filter(Boolean).join("\n\n");
      if (!text.trim()) continue;
      records.push({
        externalId: String(t.id),
        authorEmail: requester?.email ?? null,
        authorName: requester?.name ?? null,
        subject: t.subject ?? null,
        text,
        url: `https://${sub}.zendesk.com/agent/tickets/${t.id}`,
        occurredAt: t.updated_at ? new Date(t.updated_at) : null,
        raw: { status: t.status ?? null },
      });
    }

    // end_time is the cursor for the next page/sync; end_of_stream means caught up.
    const nextCursor = data.end_time != null ? String(data.end_time) : cursor;
    const done = data.end_of_stream === true || (data.tickets?.length ?? 0) === 0;
    return { records, nextCursor, done };
  },
};
