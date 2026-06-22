import "server-only";
import type { IntegrationConnection } from "@crumb/db";
import { open } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";
import { type FeedbackAdapter, type FeedbackPage, type FeedbackRecord, readConfig, lookbackStart } from "./types";

// Gong — list calls since a timestamp, then pull their transcripts.
//   https://gong.app.gong.io/settings/api/documentation
// Auth: HTTP Basic with "<access-key>:<access-key-secret>" (accessToken /
// refreshToken on the connection, both sealed). baseUrl in config (default
// https://api.gong.io). A call transcript is the hardest case — one call can
// contain several distinct feature requests, so the extraction gate fans it out.

const DEFAULT_BASE = "https://api.gong.io";
const MAX_CALLS_PER_PAGE = 100;

type GongCall = { id: string; url?: string | null; started?: string | null; title?: string | null };
type CallsResponse = { calls?: GongCall[]; records?: { cursor?: string | null } | null };
type TranscriptSentence = { text?: string | null };
type TranscriptMonologue = { sentences?: TranscriptSentence[] | null };
type CallTranscript = { callId: string; transcript?: TranscriptMonologue[] | null };
type TranscriptResponse = { callTranscripts?: CallTranscript[] };

function basicAuth(conn: IntegrationConnection): string | null {
  const key = conn.accessToken ? open(conn.accessToken) : null;
  const secret = conn.refreshToken ? open(conn.refreshToken) : null;
  if (!key || !secret) return null;
  return Buffer.from(`${key}:${secret}`).toString("base64");
}

export const gong: FeedbackAdapter = {
  provider: "gong",

  configured() {
    return true; // BYO access key + secret on the connection
  },

  async listSince(conn: IntegrationConnection, cursor: string | null): Promise<FeedbackPage> {
    const auth = basicAuth(conn);
    if (!auth) {
      log.error("gong connection incomplete", { scope: "crumb/gong", workspaceId: conn.workspaceId });
      return { records: [], nextCursor: cursor, done: true };
    }
    const base = (readConfig(conn).baseUrl?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
    const fromDateTime = cursor ?? lookbackStart().toISOString();
    const headers = { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" };

    // 1. List calls in the window.
    const callsUrl = new URL(`${base}/v2/calls`);
    callsUrl.searchParams.set("fromDateTime", fromDateTime);
    const callsResp = await fetch(callsUrl, { headers });
    if (!callsResp.ok) {
      log.error("gong list calls failed", { scope: "crumb/gong", status: callsResp.status });
      return { records: [], nextCursor: cursor, done: true };
    }
    const callsData = (await callsResp.json()) as CallsResponse;
    const calls = (callsData.calls ?? []).slice(0, MAX_CALLS_PER_PAGE);
    if (calls.length === 0) return { records: [], nextCursor: cursor, done: true };

    const byId = new Map(calls.map((c) => [c.id, c]));

    // 2. Pull transcripts for those calls.
    const tResp = await fetch(`${base}/v2/calls/transcript`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: { fromDateTime, callIds: calls.map((c) => c.id) } }),
    });
    const transcripts: Record<string, string> = {};
    if (tResp.ok) {
      const tData = (await tResp.json()) as TranscriptResponse;
      for (const ct of tData.callTranscripts ?? []) {
        const text = (ct.transcript ?? [])
          .flatMap((m) => (m.sentences ?? []).map((s) => s.text ?? ""))
          .filter(Boolean)
          .join(" ");
        if (text.trim()) transcripts[ct.callId] = text;
      }
    } else {
      log.error("gong transcript fetch failed", { scope: "crumb/gong", status: tResp.status });
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
};
