import "server-only";
import { sql } from "drizzle-orm";
import { db, feedbackAnswers, type Workspace } from "@crumb/db";
import { statusLabel } from "@crumb/ui";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL, NO_EM_DASH_RULE } from "@/lib/ai/aistack";
import { embedText, embeddingsConfigured } from "@/lib/ai/embeddings";
import { withAiBudget } from "@/lib/ai/run";
import { formatArr } from "@/lib/priority";
import { log } from "@/lib/log";

// "Ask your feedback" (feature 5): retrieval-augmented Q&A over the corpus.
// Embed the question → pgvector top-K → ground an answer in those items with
// inline [FB-N] citations. Every item reaches the model with its account, ARR,
// reach, status and date. Revenue and time questions are shaped in SQL (see
// askIntent): candidates ranked by account ARR and/or limited to a window, and
// window totals counted by the database, so the model never adds up dollars or
// counts rows itself. Cloud-only; swapped for ask.community.ts on self-host.

export function askConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const ASK_MODEL = AISTACK_MODEL;

export type AskCitation = { shortId: string; title: string };
export type AskError = "not_entitled" | "ai_cap_reached" | "embed_failed" | "no_data" | "answer_failed";
export type AskResult =
  | { ok: true; answer: string; citations: AskCitation[] }
  | { ok: false; error: AskError };

export type AskIntent = { byArr: boolean; windowDays: number | null };

const ARR_RE =
  /\b(arr|mrr|revenue|enterprise|high[- ]value|most valuable|highest[- ](arr|paying|value|revenue)|(big|bigger|biggest|large|larger|largest|key|strategic|top|major) (accounts?|customers?|clients?))\b/;
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };

// Revenue and time cues in a question. byArr ranks candidates by account ARR;
// windowDays keeps them to feedback from that many days back and adds totals
// counted by the database.
// ponytail: keyword cues, no model call. Add an intent step like ask-usage's
// if real questions slip past them.
export function askIntent(question: string): AskIntent {
  const q = question.toLowerCase();
  const n = q.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|quarter|year)s?\b/);
  const one = q.match(/\b(?:this|last|past|previous)\s+(day|week|month|quarter|year)\b/);
  const days = n ? Number(n[1]) * UNIT_DAYS[n[2]]
    : one ? UNIT_DAYS[one[1]]
    : /\btoday\b/.test(q) ? 1
    : /\byesterday\b/.test(q) ? 2
    : /\b(recent|recently|lately)\b/.test(q) ? 30
    : 0;
  return { byArr: ARR_RE.test(q), windowDays: days > 0 ? Math.min(days, 730) : null };
}

type Cand = {
  id: string;
  short_id: string;
  title: string;
  body: string;
  status: string;
  day: string;
  account: string;
  arr: string | number;
  group_arr: string | number;
  group_accts: string | number;
};

const arrText = (cents: number) => (cents > 0 ? `${formatArr(cents)} ARR` : "ARR not set");

// What came in during the window, counted by the database: submissions,
// distinct accounts, and those accounts' combined ARR.
async function windowTotals(workspaceId: string, days: number) {
  const [r] = (await db.execute(sql`
    WITH w AS (
      SELECT account_id FROM items
      WHERE workspace_id = ${workspaceId} AND created_at > now() - (${days} || ' days')::interval
    )
    SELECT (SELECT COUNT(*) FROM w)::int AS n,
           (SELECT COUNT(DISTINCT account_id) FROM w)::int AS accts,
           (SELECT COALESCE(SUM(a.arr_cents), 0) FROM accounts a WHERE a.id IN (SELECT account_id FROM w))::bigint AS arr
  `)) as unknown as Array<{ n: number | string; accts: number | string; arr: number | string }>;
  return { n: Number(r?.n ?? 0), accts: Number(r?.accts ?? 0), arr: Number(r?.arr ?? 0) };
}

export async function askFeedback(
  workspace: Workspace,
  question: string,
  askedByWorkspaceUserId: string | null,
): Promise<AskResult> {
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, error: "answer_failed" };
  if (!embeddingsConfigured()) return { ok: false, error: "not_entitled" };
  const intent = askIntent(q);

  const budget = await withAiBudget(workspace, async (): Promise<AskResult> => {
    let rows: Cand[] = [];
    let answer: string | null = null;
    let totals: string | null = null;

    if (intent.windowDays) {
      const span = intent.windowDays === 1 ? "the last day" : `the last ${intent.windowDays} days`;
      const t = await windowTotals(workspace.id, intent.windowDays);
      if (t.n === 0) answer = `No feedback came in during ${span}.`;
      else totals = `In ${span}, ${t.n} pieces of feedback came in from ${t.accts} accounts (${arrText(t.arr)} between them).`;
    }

    if (!answer) {
      const vec = await embedText(q);
      if (!vec) return { ok: false, error: "embed_failed" };
      const vecLit = `[${vec.join(",")}]`;
      const dist = sql`e.embedding <=> ${vecLit}::vector`;
      const since = intent.windowDays
        ? sql`AND i.created_at > now() - (${intent.windowDays} || ' days')::interval`
        : sql``;
      const cols = sql`i.id, i.short_id, i.title, i.body, i.status, to_char(i.created_at, 'YYYY-MM-DD') AS day,
        a.name AS account, a.arr_cents AS arr, ${dist} AS dist`;
      const from = sql`FROM item_embeddings e
        JOIN items i ON i.id = e.item_id
        JOIN accounts a ON a.id = i.account_id
        WHERE e.workspace_id = ${workspace.id} AND i.merged_into_id IS NULL ${since}`;
      // The twelve closest items (a plain ORDER BY, so the HNSW index serves it).
      const nearest = sql`SELECT ${cols} ${from} ORDER BY ${dist} ASC LIMIT 12`;
      // Revenue questions add each account's three closest items, highest ARR
      // first, so the biggest customers show up even when the question names
      // no topic ("what do our highest-ARR accounts keep asking for?").
      const pick = intent.byArr
        ? sql`(${nearest}) UNION (
            SELECT r.id, r.short_id, r.title, r.body, r.status, r.day, r.account, r.arr, r.dist
            FROM (SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY i.account_id ORDER BY ${dist}) AS rn ${from}) r
            WHERE r.rn <= 3 ORDER BY r.arr DESC, r.dist ASC LIMIT 12)`
        : nearest;
      // Reach per candidate: the merge group's distinct accounts and their
      // summed ARR, the same numbers the inbox and thread show.
      rows = (await db.execute(sql`
        SELECT c.*, g.arr AS group_arr, g.accts AS group_accts
        FROM (${pick}) c
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(ga.arr_cents), 0)::bigint AS arr, COUNT(*)::int AS accts
          FROM (SELECT DISTINCT gi.account_id FROM items gi WHERE gi.id = c.id OR gi.merged_into_id = c.id) d
          JOIN accounts ga ON ga.id = d.account_id
        ) g
        ORDER BY ${intent.byArr ? sql`c.arr DESC,` : sql``} c.dist ASC
      `)) as unknown as Cand[];
      if (rows.length === 0) return { ok: false, error: "no_data" };

      const context = rows
        .map((r) => {
          const accts = Number(r.group_accts);
          const groupArr = Number(r.group_arr);
          const reach = accts > 1 ? `; ${accts} accounts asking${groupArr > 0 ? `, ${formatArr(groupArr)} ARR combined` : ""}` : "";
          return `[${r.short_id}] ${r.title}${r.body ? `: ${r.body.slice(0, 400)}` : ""} (from ${r.account}, ${arrText(Number(r.arr))}${reach}; status ${statusLabel(r.status)}; received ${r.day})`;
        })
        .join("\n");
      const prompt = `You are answering a question using ONLY the customer feedback items below. Each item shows the account that sent it and that account's ARR, how many accounts are asking for it when more than one, its status, and the date it came in. Cite the items you rely on by their bracketed id (e.g. FB-12) inline. If the items don't answer the question, say so plainly. Never invent facts.
${intent.byArr ? "\nThe items are listed from the highest-ARR account down. When revenue matters to the answer, name the accounts and their ARR.\n" : ""}${totals ? `\nTotals counted by the database (use these for any count or total; never count or add up yourself):\n${totals}\n` : ""}
Feedback items:
${context}

Question: ${q}

Answer in 2 to 5 sentences, grounded strictly in the items and totals above, with inline [FB-N] citations. ${NO_EM_DASH_RULE}`;

      answer = await aistackChat(prompt, { maxTokens: 1500, temperature: 0.2, scope: "crumb/ai" });
      if (!answer) return { ok: false, error: "answer_failed" };
    }

    // Resolve the cited short ids back to titles + uuids from the candidate set.
    const byShort = new Map(rows.map((r) => [r.short_id.toUpperCase(), r]));
    const citedShorts = Array.from(new Set((answer.match(/FB-\d+/gi) ?? []).map((s) => s.toUpperCase())))
      .filter((id) => byShort.has(id));
    const citations: AskCitation[] = citedShorts.map((id) => ({ shortId: id, title: byShort.get(id)!.title }));
    const citedIds = citedShorts.map((id) => byShort.get(id)!.id);

    try {
      await db.insert(feedbackAnswers).values({
        workspaceId: workspace.id,
        question: q,
        answer,
        citedItemIds: citedIds,
        model: ASK_MODEL,
        askedByWorkspaceUserId: askedByWorkspaceUserId ?? null,
      });
    } catch (err) {
      log.warn("persist feedbackAnswer failed", { scope: "crumb/ai", err });
    }

    return { ok: true, answer, citations };
  });

  if (!budget.ok) return { ok: false, error: budget.error };
  return budget.value;
}
