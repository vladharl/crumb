import "server-only";
import { open } from "@/lib/crypto-at-rest";
import {
  type FeedbackAdapter, type FeedbackPage, type FeedbackRecord,
  FeedbackSyncError, cursorIso, readConfig, vendorBaseUrl, vendorFetch,
} from "./types";

// Freshchat — pull recently-updated conversations.
//   https://developers.freshchat.com/api/
// Auth: Bearer API token (the connection's sealed accessToken). The region base
// URL (e.g. https://<domain>.freshchat.com/v2) lives in config.baseUrl and must
// be on freshchat.com.
//
// NOTE: Freshchat is webhook-first; its public "list conversations updated since"
// support is thin and account-dependent. When an account doesn't expose it, the
// refusal (404/501) shows on the connection as an error rather than a sync that
// quietly finds nothing. A real-time Freshchat webhook ingest is the
// recommended follow-up.

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

  async listSince(conn, cursor): Promise<FeedbackPage> {
    const token = conn.accessToken ? open(conn.accessToken) : null;
    const base = vendorBaseUrl(readConfig(conn).baseUrl, "freshchat.com");
    if (!base || !token) throw new FeedbackSyncError("config", "Freshchat needs an API URL on freshchat.com and an API token.");

    const since = cursorIso(cursor);
    const url = new URL(`${base}/conversations`);
    url.searchParams.set("updated_time", since);
    url.searchParams.set("items_per_page", String(PER_PAGE));

    const resp = await vendorFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
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
