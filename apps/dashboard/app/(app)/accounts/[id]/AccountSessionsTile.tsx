import Link from "next/link";
import { Card, CardHead, Pill } from "@crumb/ui";
import { db, replaySessions, items, accountUsers } from "@crumb/db";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";

// Lists replay sessions belonging to a single account — currently, only
// the ones linked to a feedback item (replay_sessions.item_id IS NOT NULL).
// Orphan sessions (no item) live on the workspace, not the account, and
// will be GC'd by the sweeper. If a vendor needs to walk "everything we've
// ever recorded for Acme," this is the surface.

function fmtAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "just now";
  const units: Array<[string, number]> = [
    ["w", 1000 * 60 * 60 * 24 * 7],
    ["d", 1000 * 60 * 60 * 24],
    ["h", 1000 * 60 * 60],
    ["m", 1000 * 60],
  ];
  for (const [u, mss] of units) if (ms >= mss) return `${Math.floor(ms / mss)}${u} ago`;
  return "just now";
}

function fmtDuration(startedAt: Date, endedAt: Date | null): string {
  if (!endedAt) return "—";
  const ms = endedAt.getTime() - startedAt.getTime();
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}m ${rem}s`;
}

function shortenUrl(raw: string | null): string {
  if (!raw) return "—";
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return raw;
  }
}

export async function AccountSessionsTile({ accountId }: { accountId: string }) {
  const { workspace } = await getActiveSession();

  const rows = await db
    .select({
      id: replaySessions.id,
      startedAt: replaySessions.startedAt,
      endedAt: replaySessions.endedAt,
      pageUrl: replaySessions.pageUrl,
      eventCount: replaySessions.eventCount,
      itemShortId: items.shortId,
      itemTitle: items.title,
      submitterName: accountUsers.name,
    })
    .from(replaySessions)
    .innerJoin(items, eq(items.id, replaySessions.itemId))
    .leftJoin(accountUsers, eq(accountUsers.id, replaySessions.accountUserId))
    .where(and(
      eq(replaySessions.workspaceId, workspace.id),
      eq(items.accountId, accountId),
      isNotNull(replaySessions.itemId),
      // Linked at submit before any chunk landed; nothing to watch until one does.
      gt(replaySessions.eventCount, 0),
    ))
    .orderBy(desc(replaySessions.startedAt))
    .limit(10);

  // Off-by-default cleanly: a freshly-created workspace with the feature
  // off has zero sessions; rendering an empty card adds visual clutter.
  // We hide the whole tile when there's nothing — the Session Record
  // capability is then discovered through Settings → Integrations rather
  // than via an "empty state" advertisement on every account.
  if (!workspace.sessionRecordEnabled && rows.length === 0) return null;

  return (
    <Card>
      <CardHead
        title="Session replays"
        after={<Pill>{rows.length}</Pill>}
      />
      <div className="card-body col gap-3">
        {rows.length === 0 ? (
          <span className="text-sm muted">
            No sessions linked to feedback from this account yet. They appear here once a customer submits feedback with the recorder running.
          </span>
        ) : (
          rows.map(r => (
            <Link
              key={r.id}
              href={`/thread/${encodeURIComponent(r.itemShortId)}`}
              className="col gap-1"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="row gap-2 center">
                <span className="mono text-xs muted">{r.itemShortId}</span>
                <span className="text-sm truncate" style={{ flex: 1, minWidth: 0 }}>{r.itemTitle}</span>
                <span className="text-xs muted">{fmtDuration(r.startedAt, r.endedAt)}</span>
              </div>
              <div className="row gap-2 center text-2xs muted">
                <span>{r.submitterName ?? "Unknown"}</span>
                <span>·</span>
                <span className="truncate" title={r.pageUrl ?? undefined}>{shortenUrl(r.pageUrl)}</span>
                <span style={{ marginLeft: "auto" }}>{fmtAgo(r.startedAt)}</span>
              </div>
            </Link>
          ))
        )}
      </div>
    </Card>
  );
}
