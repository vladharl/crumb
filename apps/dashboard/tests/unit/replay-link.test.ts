import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, replaySessions, workspaces, type Item, type Workspace } from "@crumb/db";
import { linkReplaySession, recordChunk } from "@/lib/replay/ingest";
import { getReplayForItem } from "@/lib/replay/read";

// #75: a submit that reached the server before the recorder's first chunk lost
// its replay, because only a row that already had chunks could link. The submit
// now makes the row, linked, and the chunks land on it, the widget's
// pre-consent buffer included: the oldest chunk and the biggest, so it can
// arrive after a newer one. Never across workspaces or customers.
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

vi.mock("@/lib/storage", () => ({
  newStorageKey: (name: string) => `test/replay-link/${name}`,
  putBytes: async () => {},
  deleteBytes: async () => {},
}));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
const newToken = () => randomBytes(16).toString("hex");
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function chunk(ws: Workspace, sessionToken: string, sequence: number, startedAt: Date, endedAt: Date, events = 3) {
  return recordChunk({
    sessionToken,
    workspaceSlug: ws.slug,
    sequence,
    startedAt,
    endedAt,
    events: Array.from({ length: events }, (_, i) => ({ type: 3, data: {}, timestamp: startedAt.getTime() + i })),
    pageUrl: "https://app.test/billing",
    userAgent: CHROME,
  });
}

const sessionsFor = (sessionToken: string) => db
  .select({ workspaceId: replaySessions.workspaceId, itemId: replaySessions.itemId, accountUserId: replaySessions.accountUserId, eventCount: replaySessions.eventCount })
  .from(replaySessions)
  .where(eq(replaySessions.sessionToken, sessionToken));

describe.skipIf(!reachable && !process.env.CI)("replay sessions: linked at submit, chunks land late", () => {
  let acme: Workspace;
  let other: Workspace;
  let pat: { id: string };
  let lee: { id: string };
  let patBug: Item;
  let patIdea: Item;
  let leeBug: Item;

  beforeAll(async () => {
    vi.stubEnv("CRUMB_TIER", "cloud");
    const recording = { planId: "growth", subscriptionStatus: "active", sessionRecordEnabled: true };
    [acme] = await db.insert(workspaces).values({ slug: `replay-link-${tag}`, name: "Acme", ...recording }).returning();
    [other] = await db.insert(workspaces).values({ slug: `replay-link-other-${tag}`, name: "Other", ...recording }).returning();
    const [acct] = await db.insert(accounts).values({ workspaceId: acme.id, name: "Globex" }).returning({ id: accounts.id });
    [pat, lee] = await db.insert(accountUsers).values([
      { workspaceId: acme.id, accountId: acct.id, email: "pat@globex.test", name: "Pat", initials: "P" },
      { workspaceId: acme.id, accountId: acct.id, email: "lee@globex.test", name: "Lee", initials: "L" },
    ]).returning({ id: accountUsers.id });
    [patBug, patIdea, leeBug] = await db.insert(items).values([
      { workspaceId: acme.id, accountId: acct.id, submitterId: pat.id, seq: 1, shortId: "FB-1", title: "Export is empty", type: "bug" },
      { workspaceId: acme.id, accountId: acct.id, submitterId: pat.id, seq: 2, shortId: "FB-2", title: "Dark mode", type: "idea" },
      { workspaceId: acme.id, accountId: acct.id, submitterId: lee.id, seq: 3, shortId: "FB-3", title: "Login loops", type: "bug" },
    ]).returning();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const ws of [acme, other]) {
      if (!ws) continue;
      await db.delete(items).where(eq(items.workspaceId, ws.id));
      await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    }
  });

  it("a submit before the first chunk keeps the recording, the late pre-consent buffer included", async () => {
    const token = newToken();
    expect(await linkReplaySession(acme, patBug, token)).toBe(true);
    expect(await getReplayForItem("FB-1", acme.id)).toBeNull(); // nothing to watch yet

    // A regular flush lands first, then the buffer from before consent: older and bigger.
    const [bufStart, flushStart, flushEnd] = [ago(300), ago(20), ago(10)];
    expect(await chunk(acme, token, 1, flushStart, flushEnd)).toMatchObject({ ok: true });
    expect(await chunk(acme, token, 0, bufStart, flushStart, 400)).toMatchObject({ ok: true });
    // A retried upload of a sequence it already has is refused, not doubled.
    expect(await chunk(acme, token, 1, flushStart, flushEnd)).toEqual({ ok: false, status: 409, error: "duplicate_sequence" });

    const replay = await getReplayForItem("FB-1", acme.id);
    expect(replay).toMatchObject({
      itemId: patBug.id,
      eventCount: 403,
      startedAt: bufStart.toISOString(),
      endedAt: flushEnd.toISOString(),
      durationMs: flushEnd.getTime() - bufStart.getTime(),
      pageUrl: "https://app.test/billing",
      browserName: "Chrome",
    });
    expect(replay!.chunks.map(c => c.sequence)).toEqual([0, 1]);
    expect(await sessionsFor(token)).toEqual([{ workspaceId: acme.id, itemId: patBug.id, accountUserId: pat.id, eventCount: 403 }]);

    // The same customer's next item doesn't take it: the first item keeps its recording.
    expect(await linkReplaySession(acme, patIdea, token)).toBe(false);
    expect((await getReplayForItem("FB-1", acme.id))?.eventCount).toBe(403);
  });

  it("still links a recording whose chunks landed first", async () => {
    const token = newToken();
    expect(await chunk(acme, token, 0, ago(60), ago(30))).toMatchObject({ ok: true });
    expect(await linkReplaySession(acme, leeBug, token)).toBe(true);
    expect(await sessionsFor(token)).toEqual([{ workspaceId: acme.id, itemId: leeBug.id, accountUserId: lee.id, eventCount: 3 }]);
  });

  it("never takes another workspace's token or another customer's recording", async () => {
    // Recorded in the other workspace: Acme can neither link it nor append to it.
    const theirs = newToken();
    expect(await chunk(other, theirs, 0, ago(30), ago(20))).toMatchObject({ ok: true });
    expect(await linkReplaySession(acme, patIdea, theirs)).toBe(false);
    expect(await chunk(acme, theirs, 1, ago(20), ago(10))).toEqual({ ok: false, status: 403, error: "session_token_taken" });
    expect(await sessionsFor(theirs)).toEqual([{ workspaceId: other.id, itemId: null, accountUserId: null, eventCount: 3 }]);

    // Lee's recording stays on Lee's item.
    const lees = newToken();
    expect(await linkReplaySession(acme, leeBug, lees)).toBe(true);
    expect(await linkReplaySession(acme, patIdea, lees)).toBe(false);
    expect(await sessionsFor(lees)).toEqual([{ workspaceId: acme.id, itemId: leeBug.id, accountUserId: lee.id, eventCount: 0 }]);

    // Recording turned off: nothing is made.
    const off = newToken();
    expect(await linkReplaySession({ ...acme, sessionRecordEnabled: false }, patIdea, off)).toBe(false);
    expect(await sessionsFor(off)).toEqual([]);
  });

  it("an older or out-of-order first chunk still answers to the duration cap", async () => {
    // 31 minutes of buffer that ended before the submit made the row.
    const long = newToken();
    expect(await linkReplaySession(acme, patIdea, long)).toBe(true);
    expect(await chunk(acme, long, 0, ago(31 * 60 + 5), ago(5))).toEqual({ ok: false, status: 413, error: "session_too_long" });

    // Each chunk is short, but together they span 35 minutes.
    const spread = newToken();
    expect(await chunk(acme, spread, 1, ago(60), ago(1))).toMatchObject({ ok: true });
    expect(await chunk(acme, spread, 0, ago(35 * 60), ago(34 * 60))).toEqual({ ok: false, status: 413, error: "session_too_long" });
  });
});
