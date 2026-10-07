import "server-only";
import { open } from "@/lib/crypto-at-rest";
import {
  type ConnectionCreds, type FeedbackAdapter, type FeedbackPage, type FeedbackRecord,
  FeedbackSyncError, cursorIso, readConfig, vendorBaseUrl, vendorFetch,
} from "./types";

// Gong — list calls since a timestamp, then pull their transcripts.
//   https://gong.app.gong.io/settings/api/documentation
// Auth: HTTP Basic with "<access-key>:<access-key-secret>" (accessToken /
// refreshToken on the connection, both sealed). baseUrl in config (default
// https://api.gong.io; customer-specific https://<id>.api.gong.io also works,
// nothing else does). A call transcript is the hardest case — one call can
// contain several distinct feature requests, so the extraction gate fans it out.

const DEFAULT_BASE = "https://api.gong.io";
const MAX_CALLS_PER_PAGE = 100;

type GongCall = { id: string; url?: string | null; started?: string | null; title?: string | null };
type CallsResponse = { calls?: GongCall[]; records?: { totalRecords?: number; cursor?: string | null } | null };
type TranscriptSentence = { text?: string | null };
type TranscriptMonologue = { sentences?: TranscriptSentence[] | null };
type CallTranscript = { callId: string; transcript?: TranscriptMonologue[] | null };
type TranscriptResponse = { callTranscripts?: CallTranscript[] };

function account(conn: ConnectionCreds): { base: string; headers: Record<string, string> } {
  const key = conn.accessToken ? open(conn.accessToken) : null;
  const secret = conn.refreshToken ? open(conn.refreshToken) : null;
  const base = vendorBaseUrl(readConfig(conn).baseUrl?.trim() || DEFAULT_BASE, "api.gong.io");
  if (!key || !secret || !base) {
    throw new FeedbackSyncError("config", "Gong needs an access key, its secret and a base URL on api.gong.io.");
  }
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  return { base, headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" } };
}

const notFound = (err: unknown) => err instanceof FeedbackSyncError && err.status === 404;

async function listCalls(base: string, headers: Record<string, string>, fromDateTime: string): Promise<CallsResponse> {
  const url = new URL(`${base}/v2/calls`);
  url.searchParams.set("fromDateTime", fromDateTime);
  try {
    return (await (await vendorFetch(url, { headers })).json()) as CallsResponse;
  } catch (err) {
    // Gong answers an empty window with 404 "No calls found", not an empty list.
    if (notFound(err)) return { calls: [], records: { totalRecords: 0 } };
    throw err;
  }
}

export const gong: FeedbackAdapter = {
  provider: "gong",

  configured() {
    return true; // BYO access key + secret on the connection
  },

  async listSince(conn, cursor): Promise<FeedbackPage> {
    const { base, headers } = account(conn);
    const fromDateTime = cursorIso(cursor);

    // 1. List calls in the window.
    const callsData = await listCalls(base, headers, fromDateTime);
    const calls = (callsData.calls ?? []).slice(0, MAX_CALLS_PER_PAGE);
    if (calls.length === 0) return { records: [], nextCursor: cursor, done: true };

    const byId = new Map(calls.map((c) => [c.id, c]));

    // 2. Pull transcripts for those calls. A failure here fails the page, so the
    // cursor never moves past calls whose transcripts we didn't read. A 404
    // means none of them is transcribed yet: retried, not a settings problem.
    // ponytail: a page of calls that never get a transcript retries at the
    // backoff cap. Skip calls older than a day here if that shows up.
    const tResp = await vendorFetch(`${base}/v2/calls/transcript`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: { fromDateTime, callIds: calls.map((c) => c.id) } }),
    }).catch((err: unknown) => {
      throw notFound(err) ? new FeedbackSyncError("transient", "HTTP 404", 404) : err;
    });
    const transcripts: Record<string, string> = {};
    const tData = (await tResp.json()) as TranscriptResponse;
    for (const ct of tData.callTranscripts ?? []) {
      const text = (ct.transcript ?? [])
        .flatMap((m) => (m.sentences ?? []).map((s) => s.text ?? ""))
        .filter(Boolean)
        .join(" ");
      if (text.trim()) transcripts[ct.callId] = text;
    }

    const records: FeedbackRecord[] = [];
    let maxStarted = fromDateTime;
    for (const c of calls) {
      const text = transcripts[c.id];
      if (text) {
        records.push({
          externalId: c.id,
          authorEmail: null, // call parties aren't pulled in v1 — account is mapped on review
          authorName: byId.get(c.id)?.title ?? null,
          subject: c.title ?? null,
          text,
          url: c.url ?? null,
          occurredAt: c.started ? new Date(c.started) : null,
          raw: { startedAt: c.started ?? null },
        });
      }
      if (c.started && c.started > maxStarted) maxStarted = c.started;
    }

    // Gong paginates with records.cursor; absent ⇒ caught up. We advance the time
    // cursor regardless so the next sync resumes after the newest call seen.
    const more = !!callsData.records?.cursor;
    const nextCursor = new Date(new Date(maxStarted).getTime() + 1000).toISOString();
    return { records, nextCursor, done: !more };
  },

  // The calls list reports records.totalRecords for the whole window.
  async count(conn, since) {
    const { base, headers } = account(conn);
    return (await listCalls(base, headers, since.toISOString())).records?.totalRecords ?? 0;
  },
};
