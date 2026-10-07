import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { loopOpenSql } from "@/lib/loop-sql";

// Sentiment + churn-risk signals (feature 6). Aggregates the AI sentiment /
// urgency / severity that triage (#3) writes onto items, per account, into a
// revenue-weighted risk score. Pure SQL — works wherever the data exists; on
// self-host the ai_* columns are null (AI is Cloud-only), so every account
// scores "low" and the surfaces stay quiet.

export type RiskLevel = "low" | "medium" | "high";

export type AccountRisk = {
  accountId: string;
  name: string;
  arrCents: number;
  avgSentiment: number | null; // mean ai_sentiment over the last 90d (-1..1)
  sentimentTrend: number | null; // last-30d mean − prior-30d mean (<0 = worsening)
  openCount: number;
  openSevereCount: number; // open items with ai_severity high|critical
  maxUrgency: number | null;
  // Usage decline (from usage_events). recentActiveDays = distinct active days
  // in the last 30d; activityTrend = recent − prior(30-60d). A previously-active
  // account going quiet is a classic churn signal. Null on deployments with no
  // usage events (the surfaces stay quiet, same as the ai_* columns).
  recentActiveDays: number | null;
  activityTrend: number | null;
  riskLevel: RiskLevel;
  riskScore: number;
};

type Row = {
  id: string;
  name: string;
  arr_cents: number | string;
  avg_sentiment: number | string | null;
  recent_sentiment: number | string | null;
  prior_sentiment: number | string | null;
  max_urgency: number | string | null;
  open_count: number | string;
  open_severe: number | string;
  recent_active_days: number | string | null;
  prior_active_days: number | string | null;
};

// Open loop = not closed (Set aside included), the same set as the inbox.
const OPEN = loopOpenSql(sql`i.status`);

export async function accountRiskSignals(workspaceId: string): Promise<AccountRisk[]> {
  const rows = (await db.execute(sql`
    SELECT a.id AS id, a.name AS name, a.arr_cents AS arr_cents,
      AVG(i.ai_sentiment) FILTER (WHERE i.created_at > now() - interval '90 days') AS avg_sentiment,
      AVG(i.ai_sentiment) FILTER (WHERE i.created_at > now() - interval '30 days') AS recent_sentiment,
      AVG(i.ai_sentiment) FILTER (
        WHERE i.created_at <= now() - interval '30 days' AND i.created_at > now() - interval '60 days'
      ) AS prior_sentiment,
      MAX(i.ai_urgency) FILTER (WHERE i.created_at > now() - interval '90 days') AS max_urgency,
      COUNT(*) FILTER (WHERE ${OPEN}) AS open_count,
      COUNT(*) FILTER (
        WHERE i.ai_severity IN ('high','critical') AND ${OPEN}
      ) AS open_severe,
      u.recent_active_days AS recent_active_days,
      u.prior_active_days AS prior_active_days
    FROM accounts a
    LEFT JOIN items i ON i.account_id = a.id AND i.merged_into_id IS NULL
    LEFT JOIN (
      SELECT account_id,
        COUNT(DISTINCT date_trunc('day', ts)) FILTER (WHERE ts > now() - interval '30 days') AS recent_active_days,
        COUNT(DISTINCT date_trunc('day', ts)) FILTER (
          WHERE ts <= now() - interval '30 days' AND ts > now() - interval '60 days'
        ) AS prior_active_days
      FROM usage_events
      WHERE workspace_id = ${workspaceId} AND account_id IS NOT NULL
      GROUP BY account_id
    ) u ON u.account_id = a.id
    WHERE a.workspace_id = ${workspaceId}
    GROUP BY a.id, a.name, a.arr_cents, u.recent_active_days, u.prior_active_days
  `)) as unknown as Row[];

  return rows.map((r) => {
    const avg = r.avg_sentiment != null ? Number(r.avg_sentiment) : null;
    const recent = r.recent_sentiment != null ? Number(r.recent_sentiment) : null;
    const prior = r.prior_sentiment != null ? Number(r.prior_sentiment) : null;
    const trend = recent != null && prior != null ? recent - prior : null;
    const openCount = Number(r.open_count);
    const openSevere = Number(r.open_severe);
    const maxUrgency = r.max_urgency != null ? Number(r.max_urgency) : null;
    const recentActiveDays = r.recent_active_days != null ? Number(r.recent_active_days) : null;
    const priorActiveDays = r.prior_active_days != null ? Number(r.prior_active_days) : null;
    const activityTrend =
      recentActiveDays != null && priorActiveDays != null ? recentActiveDays - priorActiveDays : null;
    // A previously-active account (prior usage) that's gone quiet (near-zero
    // recent activity) is "going dark" — weight it like a worsening signal.
    const wentDark = priorActiveDays != null && priorActiveDays >= 3 && recentActiveDays != null && recentActiveDays <= 1;

    // Risk score: negative sentiment + worsening trend + open severe bugs +
    // urgency + usage going dark all push it up. Used to rank within a level.
    let score = 0;
    if (avg != null && avg < 0) score += -avg * 2;
    if (trend != null && trend < 0) score += -trend * 1.5;
    score += openSevere * 0.5;
    if (maxUrgency != null) score += maxUrgency * 0.5;
    if (wentDark) score += 1.5;

    let level: RiskLevel = "low";
    if ((avg != null && avg <= -0.2) || (trend != null && trend <= -0.3) || openSevere >= 2 || wentDark) level = "high";
    else if ((avg != null && avg < 0) || (trend != null && trend < 0) || openSevere >= 1 || (activityTrend != null && activityTrend < 0)) level = "medium";

    return {
      accountId: r.id,
      name: r.name,
      arrCents: Number(r.arr_cents),
      avgSentiment: avg,
      sentimentTrend: trend,
      openCount,
      openSevereCount: openSevere,
      maxUrgency,
      recentActiveDays,
      activityTrend,
      riskLevel: level,
      riskScore: score,
    };
  });
}

// At-risk accounts (medium+), revenue-first then by score — "high-ARR accounts
// trending negative" bubble to the top.
export function atRiskAccounts(signals: AccountRisk[]): AccountRisk[] {
  return signals
    .filter((s) => s.riskLevel !== "low")
    .sort((a, b) => b.arrCents - a.arrCents || b.riskScore - a.riskScore);
}

export function atRiskArrCents(signals: AccountRisk[]): number {
  return atRiskAccounts(signals).reduce((n, s) => n + s.arrCents, 0);
}
