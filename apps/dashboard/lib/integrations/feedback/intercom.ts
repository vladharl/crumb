import "server-only";
import { open } from "@/lib/crypto-at-rest";
import {
  type ConnectionCreds, type FeedbackAdapter, type FeedbackPage, type FeedbackRecord,
  FeedbackSyncError, cursorSeconds, vendorFetch,
} from "./types";

// Intercom — search conversations updated after a cursor.
//   https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/searchconversations
// Auth: Bearer access token (the connection's sealed accessToken — OAuth or a
// manual Access Token). Cursor: unix seconds of the newest updated_at seen.

const PER_PAGE = 50;
const API = "https://api.intercom.io";

type IntercomAuthor = { type?: string; email?: string | null; name?: string | null };
type IntercomConversation = {
  id: string;
  title?: string | null;
  updated_at?: number | null;
  source?: { author?: IntercomAuthor | null; body?: string | null } | null;
};
type SearchResponse = {
  total_count?: number;
  conversations?: IntercomConversation[];
};

function stripHtml(s: string | null | undefined): string {
  return (s ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

async function search(conn: ConnectionCreds, since: number, perPage: number): Promise<SearchResponse> {
  const token = conn.accessToken ? open(conn.accessToken) : null;
  if (!token) throw new FeedbackSyncError("config", "Intercom needs an access token.");
  const resp = await vendorFetch(`${API}/conversations/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      "Intercom-Version": "2.11",
    },
    body: JSON.stringify({
      query: { field: "updated_at", operator: ">", value: since },
      pagination: { per_page: perPage },
    }),
  });
  return (await resp.json()) as SearchResponse;
}

export const intercom: FeedbackAdapter = {
  provider: "intercom",

  configured() {
    return true; // BYO access token on the connection (OAuth app is optional)
  },

  async listSince(conn, cursor): Promise<FeedbackPage> {
    const since = cursorSeconds(cursor);
    const conversations = (await search(conn, since, PER_PAGE)).conversations ?? [];

    const records: FeedbackRecord[] = [];
    let maxUpdated = since;
    for (const c of conversations) {
      const author = c.source?.author ?? null;
      const text = stripHtml(c.source?.body);
      if (text) {
        records.push({
          externalId: c.id,
          authorEmail: author?.email ?? null,
          authorName: author?.name ?? null,
          subject: c.title ?? null,
          text,
          url: `https://app.intercom.com/a/inbox/_/inbox/conversation/${c.id}`,
          occurredAt: c.updated_at ? new Date(c.updated_at * 1000) : null,
          raw: { authorType: author?.type ?? null },
        });
      }
      if (c.updated_at && c.updated_at > maxUpdated) maxUpdated = c.updated_at;
    }

    const done = conversations.length < PER_PAGE;
    const nextCursor = conversations.length ? String(maxUpdated + 1) : cursor;
    return { records, nextCursor, done };
  },

  // Search reports total_count; ask for one row to get it.
  async count(conn, since) {
    return (await search(conn, Math.floor(since.getTime() / 1000), 1)).total_count ?? 0;
  },
};
