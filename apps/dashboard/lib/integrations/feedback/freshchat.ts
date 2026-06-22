import "server-only";
import type { IntegrationConnection } from "@crumb/db";
import { open } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";
import { type FeedbackAdapter, type FeedbackPage, type FeedbackRecord, readConfig, lookbackStart } from "./types";

// Freshchat — pull recently-updated conversations.
//   https://developers.freshchat.com/api/
// Auth: Bearer API token (the connection's sealed accessToken). The region base
// URL (e.g. https://<domain>.freshchat.com/v2) lives in config.baseUrl.
//
// NOTE: Freshchat is webhook-first; its public "list conversations updated since"
// support is thin and account-dependent. This polling adapter tries the
// documented endpoint and DEGRADES SAFELY (logs + done) when it isn't available,
// so a misconfigured/unsupported account never errors the whole sync. A
// real-time Freshchat webhook ingest is the recommended follow-up.

const PER_PAGE = 50;

type FreshchatUser = { email?: string | null; first_name?: string | null; last_name?: string | null };
type FreshchatMessagePart = { text?: { content?: string | null } | null };
type FreshchatMessage = { message_parts?: FreshchatMessagePart[] | null };
type FreshchatConversation = {
  conversation_id: string;
  updated_time?: string | null;
  messages?: FreshchatMessage[] | null;
  users?: FreshchatUser[] | null;
};
type ConversationsResponse = { conversations?: FreshchatConversation[] };

function fullName(u: FreshchatUser | undefined): string | null {
  if (!u) return null;
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return n || null;
}

export const freshchat: FeedbackAdapter = {
  provider: "freshchat",

  configured() {
    return true; // BYO API token + region base URL on the connection
  },

  async listSince(conn: IntegrationConnection, cursor: string | null): Promise<FeedbackPage> {
    const cfg = readConfig(conn);
    const token = conn.accessToken ? open(conn.accessToken) : null;
    if (!cfg.baseUrl || !token) {
      log.error("freshchat connection incomplete", { scope: "crumb/freshchat", workspaceId: conn.workspaceId });
      return { records: [], nextCursor: cursor, done: true };
    }

    const base = cfg.baseUrl.replace(/\/+$/, "");
    const since = cursor ?? lookbackStart().toISOString();
    const url = new URL(`${base}/conversations`);
    url.searchParams.set("updated_time", since);
    url.searchParams.set("items_per_page", String(PER_PAGE));

    let resp: Response;
    try {
      resp = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (err) {
      log.error("freshchat fetch failed", { scope: "crumb/freshchat", err });
      return { records: [], nextCursor: cursor, done: true };
    }
    if (!resp.ok) {
      // 404/501 here usually means the account/plan doesn't expose conversation
      // polling — degrade to "nothing to do" rather than erroring the sync.
      log.warn("freshchat list conversations unavailable", { scope: "crumb/freshchat", status: resp.status });
      return { records: [], nextCursor: cursor, done: true };
    }
    const data = (await resp.json()) as ConversationsResponse;
    const conversations = data.conversations ?? [];

    const records: FeedbackRecord[] = [];
    let maxUpdated = since;
    for (const c of conversations) {
      const text = (c.messages ?? [])
        .flatMap((m) => (m.message_parts ?? []).map((p) => p.text?.content ?? ""))
        .filter(Boolean)
        .join("\n");
      const user = (c.users ?? [])[0];
      if (text.trim()) {
        records.push({
          externalId: c.conversation_id,
          authorEmail: user?.email ?? null,
          authorName: fullName(user),
          subject: null,
          text,
          url: null,
          occurredAt: c.updated_time ? new Date(c.updated_time) : null,
        });
      }
      if (c.updated_time && c.updated_time > maxUpdated) maxUpdated = c.updated_time;
    }

    const done = conversations.length < PER_PAGE;
    const nextCursor = conversations.length ? new Date(new Date(maxUpdated).getTime() + 1000).toISOString() : cursor;
    return { records, nextCursor, done };
  },
};
