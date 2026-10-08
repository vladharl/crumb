import "server-only";
import type { IntegrationConnection } from "@crumb/db";
import { open } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";
import { type FeedbackAdapter, type FeedbackPage, type FeedbackRecord, readConfig, lookbackStart, vendorSubdomain } from "./types";

// Freshdesk — list tickets updated since a timestamp.
//   https://developers.freshdesk.com/api/#list_all_tickets
// Auth: HTTP Basic with "<api-key>:X" (the connection's sealed accessToken is
// the API key). The domain (<domain>.freshdesk.com) lives in config. Shares the
// ticket → 0/1-unit shape with Zendesk. Requester email isn't sideloaded by the
// list endpoint, so it's left null (the gate then holds for human mapping).

const PAGE_LIMIT = 100;

type FreshdeskTicket = {
  id: number;
  subject?: string | null;
  description_text?: string | null;
  description?: string | null;
  updated_at?: string | null;
  status?: number | null;
};

export const freshdesk: FeedbackAdapter = {
  provider: "freshdesk",

  configured() {
    return true; // BYO domain + API key on the connection
  },

  async listSince(conn: IntegrationConnection, cursor: string | null): Promise<FeedbackPage> {
    const cfg = readConfig(conn);
    const apiKey = conn.accessToken ? open(conn.accessToken) : null;
    if (!cfg.domain || !apiKey) {
      log.error("freshdesk connection incomplete", { scope: "crumb/freshdesk", workspaceId: conn.workspaceId });
      return { records: [], nextCursor: cursor, done: true };
    }
    const domain = vendorSubdomain(cfg.domain);
    if (!domain) throw new Error('Invalid Freshdesk domain. Enter just the "acme" of acme.freshdesk.com.');

    const since = cursor ?? lookbackStart().toISOString();
    const url = new URL(`https://${domain}.freshdesk.com/api/v2/tickets`);
    url.searchParams.set("updated_since", since);
    url.searchParams.set("order_by", "updated_at");
    url.searchParams.set("order_type", "asc");
    url.searchParams.set("per_page", String(PAGE_LIMIT));

    const auth = Buffer.from(`${apiKey}:X`).toString("base64");
    const resp = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" }, redirect: "manual" });
    if (!resp.ok) {
      log.error("freshdesk list tickets failed", { scope: "crumb/freshdesk", status: resp.status });
      return { records: [], nextCursor: cursor, done: true };
    }
    const tickets = (await resp.json()) as FreshdeskTicket[];

    const records: FeedbackRecord[] = [];
    let maxUpdated = since;
    for (const t of tickets) {
      const body = t.description_text || t.description || "";
      const text = [t.subject, body].filter(Boolean).join("\n\n");
      if (text.trim()) {
        records.push({
          externalId: String(t.id),
          authorEmail: null,
          authorName: null,
          subject: t.subject ?? null,
          text,
          url: `https://${domain}.freshdesk.com/a/tickets/${t.id}`,
          occurredAt: t.updated_at ? new Date(t.updated_at) : null,
          raw: { status: t.status ?? null },
        });
      }
      if (t.updated_at && t.updated_at > maxUpdated) maxUpdated = t.updated_at;
    }

    const done = tickets.length < PAGE_LIMIT;
    // Advance one millisecond past the newest seen so the next sync excludes it.
    const nextCursor = tickets.length ? new Date(new Date(maxUpdated).getTime() + 1000).toISOString() : cursor;
    return { records, nextCursor, done };
  },
};
