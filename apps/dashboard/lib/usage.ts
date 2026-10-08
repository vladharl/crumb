import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, usageCounters, type Workspace } from "@crumb/db";
import { workspacePlan, type Plan } from "./entitlements";

// Per-workspace monthly usage metering + caps — the cost-control layer for
// the metered Cloud features. Three metrics:
//   "ai"           → count of LLM inference calls (clustering + ticket drafts)
//   "replay_bytes" → bytes of replay session data ingested
//   "usage_events" → count of product usage events ingested via crumb.track()
//
// Caps are per-plan, monthly, and reset automatically via the UTC "YYYY-MM"
// period key (no cron). They only bite on Cloud — self-host's plan is always
// "free" and the metered features never run there, so the cap checks are
// reached only when the feature is already entitled.

export type UsageMetric = "ai" | "replay_bytes" | "usage_events";

// Per-plan monthly caps. 0 = the feature isn't on this plan (so a cap check
// fails closed). Tune as pricing evolves; env overrides below.
const AI_CAP_BY_PLAN: Record<Plan, number> = { free: 0, team: 2_000, growth: 10_000 };
const REPLAY_MB_CAP_BY_PLAN: Record<Plan, number> = { free: 0, team: 0, growth: 5_120 }; // 5 GB
// Usage-event ingestion is the highest-volume metric. Generous monthly caps;
// self-host doesn't meter (see checkUsageEventsCap).
const USAGE_EVENTS_CAP_BY_PLAN: Record<Plan, number> = { free: 0, team: 500_000, growth: 2_000_000 };

function envInt(name: string): number | null {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// The AI-ops cap for a workspace this month. Env CRUMB_AI_MONTHLY_CAP
// overrides the per-plan default (for any plan that already includes AI).
export function aiCap(ws: Pick<Workspace, "planId" | "subscriptionStatus">): number {
  const base = AI_CAP_BY_PLAN[workspacePlan(ws)];
  if (base === 0) return 0;
  return envInt("CRUMB_AI_MONTHLY_CAP") ?? base;
}

// Replay byte cap for a workspace this month. Env CRUMB_REPLAY_MONTHLY_MB
// overrides the per-plan default (megabytes → bytes).
export function replayBytesCap(ws: Pick<Workspace, "planId" | "subscriptionStatus">): number {
  const baseMb = REPLAY_MB_CAP_BY_PLAN[workspacePlan(ws)];
  if (baseMb === 0) return 0;
  const mb = envInt("CRUMB_REPLAY_MONTHLY_MB") ?? baseMb;
  return mb * 1024 * 1024;
}

// UTC month key, e.g. "2026-05".
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// When this month's counters reset: the first instant of next UTC month, the
// moment currentPeriod() rolls over.
export function usageResetsAt(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Whole percent of `cap` used, for the in-app banners. Floored so "80%" never
// shows early, capped at 100; no cap reads as used up.
export function usagePercent(used: number, cap: number): number {
  return cap > 0 ? Math.min(100, Math.floor((used / cap) * 100)) : 100;
}

export async function getUsage(workspaceId: string, metric: UsageMetric, period = currentPeriod()): Promise<number> {
  const [row] = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(and(
      eq(usageCounters.workspaceId, workspaceId),
      eq(usageCounters.metric, metric),
      eq(usageCounters.period, period),
    ))
    .limit(1);
  return row?.count ?? 0;
}

// Atomic upsert bump. Safe under concurrency (the metered features fire in
// parallel) because the increment happens in a single SQL statement.
export async function incrementUsage(
  workspaceId: string,
  metric: UsageMetric,
  by = 1,
  period = currentPeriod(),
): Promise<void> {
  if (by <= 0) return;
  await db
    .insert(usageCounters)
    .values({ workspaceId, metric, period, count: by })
    .onConflictDoUpdate({
      target: [usageCounters.workspaceId, usageCounters.metric, usageCounters.period],
      set: { count: sql`${usageCounters.count} + ${by}`, updatedAt: new Date() },
    });
}

export type CapCheck = { allowed: boolean; used: number; cap: number };

// Atomically consume one AI unit if under the monthly cap. The conditional
// upsert (`WHERE count < cap` on conflict) makes the check-and-increment a
// single statement, so concurrent requests can't both slip past the cap
// (no TOCTOU), and the unit is counted BEFORE the model call so a crash
// mid-call can't under-count. Returns whether a unit was consumed.
//
// Counting before the call means a failed inference still counts — correct
// for a *cost* ceiling (we bound spend; an attempted call costs money too).
export async function consumeAi(ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">): Promise<{ ok: boolean; cap: number }> {
  const cap = aiCap(ws);
  if (cap <= 0) return { ok: false, cap };
  const rows = await db.execute(sql`
    insert into usage_counters (workspace_id, metric, period, count)
    values (${ws.id}::uuid, 'ai', ${currentPeriod()}, 1)
    on conflict (workspace_id, metric, period)
    do update set count = usage_counters.count + 1, updated_at = now()
    where usage_counters.count < ${cap}
    returning count
  `);
  return { ok: (rows as unknown as unknown[]).length > 0, cap };
}

// "Is there budget for `addBytes` more replay data this month?"
export async function checkReplayBytesCap(
  ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">,
  addBytes: number,
): Promise<CapCheck> {
  const cap = replayBytesCap(ws);
  const used = await getUsage(ws.id, "replay_bytes");
  return { allowed: used + addBytes <= cap, used, cap };
}

// Monthly usage-event cap for a workspace. Env CRUMB_USAGE_EVENTS_MONTHLY_CAP
// overrides the per-plan default.
export function usageEventsCap(ws: Pick<Workspace, "planId" | "subscriptionStatus">): number {
  const base = USAGE_EVENTS_CAP_BY_PLAN[workspacePlan(ws)];
  if (base === 0) return 0;
  return envInt("CRUMB_USAGE_EVENTS_MONTHLY_CAP") ?? base;
}

// "Is there budget for `addCount` more usage events this month?" Self-host
// (isUnmetered) never meters — ingestion is a capability there, not a paid
// metered feature — so it always has budget.
export async function checkUsageEventsCap(
  ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">,
  addCount: number,
  isUnmetered = false,
): Promise<CapCheck> {
  if (isUnmetered) return { allowed: true, used: 0, cap: Infinity };
  const cap = usageEventsCap(ws);
  const used = await getUsage(ws.id, "usage_events");
  return { allowed: used + addCount <= cap, used, cap };
}

export type AiUsage = { used: number; cap: number; percent: number; resetsAt: Date };

// This month's AI budget for the in-app banners (Ask, the inbox). Null when the
// plan has no AI, so there's nothing to meter and no query runs.
export async function getAiUsage(ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">): Promise<AiUsage | null> {
  const cap = aiCap(ws);
  if (cap <= 0) return null;
  const used = await getUsage(ws.id, "ai");
  return { used, cap, percent: usagePercent(used, cap), resetsAt: usageResetsAt() };
}

export type UsageLine = { metric: UsageMetric; used: number; cap: number };

// Current-month consumption vs cap for every metered metric the workspace's
// plan actually includes (cap > 0). For the billing page's "this month" view:
// free yields [] (no metered features); team yields ai + usage_events; growth
// adds replay_bytes. Caps reflect any env overrides via the *Cap() helpers.
export async function getUsageSummary(
  ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">,
): Promise<UsageLine[]> {
  const lines: UsageLine[] = [];
  const ai = aiCap(ws);
  if (ai > 0) lines.push({ metric: "ai", used: await getUsage(ws.id, "ai"), cap: ai });
  const replay = replayBytesCap(ws);
  if (replay > 0) lines.push({ metric: "replay_bytes", used: await getUsage(ws.id, "replay_bytes"), cap: replay });
  const events = usageEventsCap(ws);
  if (events > 0) lines.push({ metric: "usage_events", used: await getUsage(ws.id, "usage_events"), cap: events });
  return lines;
}
