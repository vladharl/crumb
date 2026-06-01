import "server-only";
import { sql } from "drizzle-orm";
import { db, feedbackAnswers, type Workspace } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { aistackChat, aistackConfigured, AISTACK_MODEL } from "@/lib/ai/aistack";
import { embedText, embeddingsConfigured } from "@/lib/ai/embeddings";
import { withAiBudget } from "@/lib/ai/run";
import { log } from "@/lib/log";

// "Ask your feedback" (feature 5): retrieval-augmented Q&A over the corpus.
// Embed the question → pgvector top-K → ground an answer in those items with
// inline [FB-N] citations. Cloud-only; swapped for ask.community.ts on self-host.

export function askConfigured(): boolean {
  return isCloud() && aistackConfigured();
}

export const ASK_MODEL = AISTACK_MODEL;

export type AskCitation = { shortId: string; title: string };
export type AskError = "not_entitled" | "ai_cap_reached" | "embed_failed" | "no_data" | "answer_failed";
export type AskResult =
  | { ok: true; answer: string; citations: AskCitation[] }
  | { ok: false; error: AskError };

type Cand = { id: string; short_id: string; title: string; body: string };

export async function askFeedback(
  workspace: Workspace,
  question: string,
  askedByWorkspaceUserId: string | null,
): Promise<AskResult> {
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, error: "answer_failed" };
  if (!embeddingsConfigured()) return { ok: false, error: "not_entitled" };

  const budget = await withAiBudget(workspace, async (): Promise<AskResult> => {
    const vec = await embedText(q);
    if (!vec) return { ok: false, error: "embed_failed" };
    const vecLit = `[${vec.join(",")}]`;

    const rows = (await db.execute(sql`
      SELECT i.id AS id, i.short_id AS short_id, i.title AS title, i.body AS body
      FROM item_embeddings e JOIN items i ON i.id = e.item_id
      WHERE e.workspace_id = ${workspace.id} AND i.merged_into_id IS NULL
      ORDER BY e.embedding <=> ${vecLit}::vector ASC
      LIMIT 12
    `)) as unknown as Cand[];
    if (rows.length === 0) return { ok: false, error: "no_data" };

    const context = rows
      .map((r) => `[${r.short_id}] ${r.title}${r.body ? ` — ${r.body.slice(0, 400)}` : ""}`)
      .join("\n");
    const prompt = `You are answering a question using ONLY the customer feedback items below. Cite the items you rely on by their bracketed id (e.g. FB-12) inline. If the items don't answer the question, say so plainly — never invent facts.

Feedback items:
${context}

Question: ${q}

Answer in 2–5 sentences, grounded strictly in the items above, with inline [FB-N] citations.`;

    const answer = await aistackChat(prompt, { maxTokens: 1500, temperature: 0.2, scope: "crumb/ai" });
    if (!answer) return { ok: false, error: "answer_failed" };

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
