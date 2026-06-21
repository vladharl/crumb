import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";

// Product-usage signals derived from usage_events, per account. Pure SQL, same
// philosophy as lib/insights/churn.ts — works wherever the data exists; on a
// deployment with no events every account simply reads zero/null and the
// surfaces stay quiet. The aggregations look back ≤30d so they stay cheap
// against the (workspace_id, ts) / (account_id, ts) indexes.

export type AccountUsage = {
  accountId: string;
  lastActiveAt: Date | null;
  wau: number; // distinct account_users active in the last 7 days
  eventCount30d: number;
};

type Row = {
  account_id: string;
  last_active_at: string | null;
  wau: number | string;
  events_30d: number | string;
};

// One row per account that has any events. Callers join by accountId; accounts
// with no events are simply absent from the map (treat as zero).
export async function accountUsageSignals(workspaceId: string): Promise<Map<string, AccountUsage>> {
  const rows = (await db.execute(sql`
    SELECT ue.account_id AS account_id,
      MAX(ue.ts) AS last_active_at,
      COUNT(DISTINCT ue.account_user_id) FILTER (WHERE ue.ts > now() - interval '7 days') AS wau,
      COUNT(*) FILTER (WHERE ue.ts > now() - interval '30 days') AS events_30d
    FROM usage_events ue
    WHERE ue.workspace_id = ${workspaceId} AND ue.account_id IS NOT NULL
    GROUP BY ue.account_id
  `)) as unknown as Row[];

  const map = new Map<string, AccountUsage>();
  for (const r of rows) {
    map.set(r.account_id, {
      accountId: r.account_id,
      lastActiveAt: r.last_active_at ? new Date(r.last_active_at) : null,
      wau: Number(r.wau),
      eventCount30d: Number(r.events_30d),
    });
  }
  return map;
}

export type TopEvent = { name: string; count: number };

// Top event names for one account over the last 30 days — the "what do they
// use" block on the account detail page.
export async function accountTopEvents(accountId: string, limit = 6): Promise<TopEvent[]> {
  const rows = (await db.execute(sql`
    SELECT name, COUNT(*) AS n
    FROM usage_events
    WHERE account_id = ${accountId} AND ts > now() - interval '30 days'
    GROUP BY name
    ORDER BY n DESC
    LIMIT ${limit}
  `)) as unknown as Array<{ name: string; n: number | string }>;
  return rows.map((r) => ({ name: r.name, count: Number(r.n) }));
}

export type KnownEvent = { name: string; count: number };

// Distinct usage-event names seen in the workspace over the last 90 days, with
// their volume — the suggestion set for the initiative "tracked events" picker.
// Ordered by recent volume so the events most worth tracking surface first.
// Cheap against the (workspace_id, name, ts) index; capped so a chatty
// integration can't return thousands of names. Empty on deployments with no
// events (or no analytics entitlement) — callers fall back to free text.
export async function knownEventNames(workspaceId: string, limit = 200): Promise<KnownEvent[]> {
  const rows = (await db.execute(sql`
    SELECT name, COUNT(*) AS n
    FROM usage_events
    WHERE workspace_id = ${workspaceId} AND ts > now() - interval '90 days'
    GROUP BY name
    ORDER BY n DESC, name ASC
    LIMIT ${limit}
  `)) as unknown as Array<{ name: string; n: number | string }>;
  return rows.map((r) => ({ name: r.name, count: Number(r.n) }));
}

export type UsageEventRow = { name: string; ts: Date; pageUrl: string | null; props: Record<string, unknown> };

// The submitter's events in the window leading up to a feedback item — powers
// the thread breadcrumb. Looks at the account_user's activity before the item
// was created (best-effort context; complements session replay).
export async function eventsBefore(opts: {
  accountUserId: string;
  before: Date;
  limit?: number;
}): Promise<UsageEventRow[]> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
  const rows = (await db.execute(sql`
    SELECT name, ts, page_url, props
    FROM usage_events
    WHERE account_user_id = ${opts.accountUserId} AND ts <= ${opts.before}
    ORDER BY ts DESC
    LIMIT ${limit}
  `)) as unknown as Array<{ name: string; ts: string; page_url: string | null; props: Record<string, unknown> | null }>;
  // Oldest → newest so the breadcrumb reads top-to-bottom toward the feedback.
  return rows
    .map((r) => ({ name: r.name, ts: new Date(r.ts), pageUrl: r.page_url, props: r.props ?? {} }))
    .reverse();
}

// Adoption of a set of event names before/after a date — the initiative-impact
// measurement (compare distinct active accounts in the equal windows around
// the ship date). Returns nulls when there's no signal so callers can hide.
export async function adoptionAround(opts: {
  workspaceId: string;
  eventNames: string[];
  pivot: Date;
  windowDays?: number;
}): Promise<{ before: number; after: number } | null> {
  if (!opts.eventNames.length) return null;
  const days = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : 30;
  const rows = (await db.execute(sql`
    SELECT
      COUNT(DISTINCT account_id) FILTER (
        WHERE ts >= ${opts.pivot}::timestamptz - (${days} || ' days')::interval AND ts < ${opts.pivot}
      ) AS before_n,
      COUNT(DISTINCT account_id) FILTER (
        WHERE ts >= ${opts.pivot} AND ts < ${opts.pivot}::timestamptz + (${days} || ' days')::interval
      ) AS after_n
    FROM usage_events
    WHERE workspace_id = ${opts.workspaceId} AND name = ANY(${opts.eventNames})
  `)) as unknown as Array<{ before_n: number | string; after_n: number | string }>;
  const r = rows[0];
  if (!r) return null;
  return { before: Number(r.before_n), after: Number(r.after_n) };
}
