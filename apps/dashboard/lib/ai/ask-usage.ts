import "server-only";
import { sql } from "drizzle-orm";
import { db, type Workspace } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL, noEmDash } from "@/lib/ai/aistack";
import { withAiBudget } from "@/lib/ai/run";
import { log } from "@/lib/log";

// "Ask your usage" — natural-language questions over usage_events. Deliberately
// NOT free text-to-SQL (that would break the grounding/safety posture of
// lib/ai/ask.ts and risk injection / unbounded scans). Instead the LLM only
// maps intent → parameters over a FIXED metric catalog; the actual queries are
// hand-written parameterized SQL, churn.ts-style. Cloud-only; swapped for
// ask-usage.community.ts on self-host.

export function askUsageConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const ASK_USAGE_MODEL = AISTACK_MODEL;

export type AskUsageError = "not_entitled" | "ai_cap_reached" | "no_data" | "answer_failed" | "unclear";
export type AskUsageResult =
  | { ok: true; answer: string; metric: string; windowDays: number }
  | { ok: false; error: AskUsageError };

const METRICS = ["active_accounts", "active_users", "event_count", "accounts_using_event", "adoption_trend"] as const;
type Metric = (typeof METRICS)[number];

const ARR_TIERS = ["all", "enterprise", "mid", "smb"] as const;
type ArrTier = (typeof ARR_TIERS)[number];

type Intent = { metric: Metric; eventName: string | null; windowDays: number; arrTier: ArrTier };

// ARR tier → cents thresholds, matching the insights page tier buckets.
function tierClause(tier: ArrTier): ReturnType<typeof sql> | null {
  switch (tier) {
    case "enterprise": return sql`a.arr_cents >= 10000000`;
    case "mid": return sql`a.arr_cents >= 1000000 AND a.arr_cents < 10000000`;
    case "smb": return sql`a.arr_cents < 1000000`;
    default: return null;
  }
}

// Distinct event names seen recently — the closed set the LLM may choose from.
async function knownEventNames(workspaceId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT name FROM usage_events
    WHERE workspace_id = ${workspaceId} AND ts > now() - interval '90 days'
    ORDER BY name
    LIMIT 200
  `)) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

async function extractIntent(question: string, names: string[]): Promise<Intent | null> {
  const prompt = `You translate a question about product-usage analytics into parameters for a FIXED set of metrics. Do not write SQL. Choose exactly one metric.

Metrics:
- active_accounts: number of distinct customer accounts active in the window
- active_users: number of distinct end-users active in the window
- event_count: total count of a specific event (requires event_name) in the window
- accounts_using_event: distinct accounts that fired a specific event (requires event_name), optionally filtered by ARR tier
- adoption_trend: distinct accounts firing a specific event in the recent window vs the prior equal window (requires event_name)

Known event names (event_name MUST be one of these, or null):
${names.length ? names.map((n) => `- ${n}`).join("\n") : "(none tracked yet)"}

ARR tiers: all | enterprise (≥ $100k) | mid ($10k–100k) | smb (< $10k)

Question: ${question}

Respond with a single line of JSON only, no prose and no code fences. Schema:
{"metric": "<one of the metrics>", "event_name": "<known name or null>", "window_days": <integer 1..180>, "arr_tier": "all|enterprise|mid|smb"}

Rules:
- If the metric needs an event_name but the question doesn't map to a known name, set metric to whatever fits best and event_name to null; the caller will ask for clarification.
- Default window_days to 7 for "this week", 30 for "this month", else 30.`;

  const text = await aistackChat(prompt, { maxTokens: 1024, temperature: 0.1, scope: "crumb/ai" });
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const cleaned = (m ? m[0] : text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const p = JSON.parse(cleaned) as { metric: string; event_name: string | null; window_days: number; arr_tier: string };
    if (!METRICS.includes(p.metric as Metric)) return null;
    const windowDays = Math.min(180, Math.max(1, Math.round(Number(p.window_days) || 30)));
    const arrTier = ARR_TIERS.includes(p.arr_tier as ArrTier) ? (p.arr_tier as ArrTier) : "all";
    // Only accept an event name from the known set. aistackChat rewrote any
    // em-dash in the reply, so compare names the same way.
    const eventName = names.find((n) => n === p.event_name || noEmDash(n) === p.event_name) ?? null;
    return { metric: p.metric as Metric, eventName, windowDays, arrTier };
  } catch (err) {
    log.error("ask-usage intent parse failed", { scope: "crumb/ai", err });
    return null;
  }
}

// Run the chosen catalog metric. Returns a number, or null when the metric
// needs an event name that wasn't resolved.
async function runMetric(workspaceId: string, intent: Intent): Promise<{ value: number; secondary?: number } | null> {
  const w = sql`(${intent.windowDays} || ' days')::interval`;
  switch (intent.metric) {
    case "active_accounts": {
      const r = (await db.execute(sql`
        SELECT COUNT(DISTINCT account_id) AS n FROM usage_events
        WHERE workspace_id = ${workspaceId} AND account_id IS NOT NULL AND ts > now() - ${w}
      `)) as unknown as Array<{ n: number | string }>;
      return { value: Number(r[0]?.n ?? 0) };
    }
    case "active_users": {
      const r = (await db.execute(sql`
        SELECT COUNT(DISTINCT account_user_id) AS n FROM usage_events
        WHERE workspace_id = ${workspaceId} AND account_user_id IS NOT NULL AND ts > now() - ${w}
      `)) as unknown as Array<{ n: number | string }>;
      return { value: Number(r[0]?.n ?? 0) };
    }
    case "event_count": {
      if (!intent.eventName) return null;
      const r = (await db.execute(sql`
        SELECT COUNT(*) AS n FROM usage_events
        WHERE workspace_id = ${workspaceId} AND name = ${intent.eventName} AND ts > now() - ${w}
      `)) as unknown as Array<{ n: number | string }>;
      return { value: Number(r[0]?.n ?? 0) };
    }
    case "accounts_using_event": {
      if (!intent.eventName) return null;
      const tier = tierClause(intent.arrTier);
      const r = (await db.execute(sql`
        SELECT COUNT(DISTINCT ue.account_id) AS n
        FROM usage_events ue
        JOIN accounts a ON a.id = ue.account_id
        WHERE ue.workspace_id = ${workspaceId} AND ue.name = ${intent.eventName} AND ue.ts > now() - ${w}
        ${tier ? sql`AND ${tier}` : sql``}
      `)) as unknown as Array<{ n: number | string }>;
      return { value: Number(r[0]?.n ?? 0) };
    }
    case "adoption_trend": {
      if (!intent.eventName) return null;
      const r = (await db.execute(sql`
        SELECT
          COUNT(DISTINCT account_id) FILTER (WHERE ts > now() - ${w}) AS recent,
          COUNT(DISTINCT account_id) FILTER (
            WHERE ts <= now() - ${w} AND ts > now() - ${w} - ${w}
          ) AS prior
        FROM usage_events
        WHERE workspace_id = ${workspaceId} AND name = ${intent.eventName} AND account_id IS NOT NULL
      `)) as unknown as Array<{ recent: number | string; prior: number | string }>;
      return { value: Number(r[0]?.recent ?? 0), secondary: Number(r[0]?.prior ?? 0) };
    }
  }
}

function phrase(intent: Intent, res: { value: number; secondary?: number }): string {
  const d = intent.windowDays;
  const ev = intent.eventName ? `\`${intent.eventName}\`` : "that event";
  const tier = intent.arrTier === "all" ? "" : ` ${intent.arrTier}`;
  switch (intent.metric) {
    case "active_accounts": return `${res.value.toLocaleString()} accounts were active in the last ${d} days.`;
    case "active_users": return `${res.value.toLocaleString()} end-users were active in the last ${d} days.`;
    case "event_count": return `${ev} fired ${res.value.toLocaleString()} times in the last ${d} days.`;
    case "accounts_using_event": return `${res.value.toLocaleString()}${tier} accounts used ${ev} in the last ${d} days.`;
    case "adoption_trend": {
      const recent = res.value, prior = res.secondary ?? 0;
      const delta = recent === prior ? "the same as" : `${recent > prior ? "up" : "down"} from ${prior.toLocaleString()}`;
      return `${recent.toLocaleString()} accounts used ${ev} in the last ${d} days, ${delta} in the prior ${d} days.`;
    }
  }
}

export async function askUsage(workspace: Workspace, question: string): Promise<AskUsageResult> {
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, error: "answer_failed" };
  if (!aistackConfigured()) return { ok: false, error: "not_entitled" };

  const budget = await withAiBudget(workspace, async (): Promise<AskUsageResult> => {
    const names = await knownEventNames(workspace.id);
    const intent = await extractIntent(q, names);
    if (!intent) return { ok: false, error: "unclear" };

    const res = await runMetric(workspace.id, intent);
    if (res === null) return { ok: false, error: "unclear" }; // needed an event name we couldn't resolve

    return { ok: true, answer: phrase(intent, res), metric: intent.metric, windowDays: intent.windowDays };
  });

  if (!budget.ok) return { ok: false, error: budget.error };
  return budget.value;
}
