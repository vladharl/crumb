import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/server";
import { hasFeature, usageAnalyticsAllowed } from "@/lib/entitlements";
import { aistackChat } from "@/lib/ai/aistack";
import { askFeedback } from "@/lib/ai/ask";
import { askUsage } from "@/lib/ai/ask-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cloud-only "Ask" endpoint. Lives under ee/ so it's overlaid into app/ on
// cloud builds and stripped on community (404 on self-host). One smart box: the
// server auto-routes each question to "feedback" (RAG over the feedback corpus)
// or "usage" (a safe metric catalog over usage_events). Entitlement + monthly
// metering happen inside the lib (withAiBudget). classifyAsk stays in this ee/
// file so the aistack client never enters the community bundle.

// Cheap intent regex — strong usage signals. Used as the primary fast path and
// as the fallback when the LLM classifier is unavailable/ambiguous.
const USAGE_RE = /\b(how many|how much|active (users|accounts)|adoption|trend(ing)?|usage|used|using|count of|number of|\bMAU\b|\bDAU\b|last (week|month|\d+ days)|past \d+ days)\b/i;
// Words that make a counting, revenue or time question about what customers
// asked for ("how much ARR is asking for SSO?", "how many requests last
// month?"). The feedback engine answers those from SQL totals.
const FEEDBACK_RE = /\b(feedback|requests?|requested|ask(s|ed|ing)? for|asking|want(s|ed)?|bugs?|complain\w*|said|mention\w*)\b/i;

// Decide feedback vs usage. Defaults to "feedback" (broadly applicable, safe)
// on any uncertainty. The LLM call is tiny and best-effort; the regex is the
// floor so routing still works when aistack is down.
async function classifyAsk(question: string): Promise<"feedback" | "usage"> {
  const heuristic: "feedback" | "usage" =
    USAGE_RE.test(question) && !FEEDBACK_RE.test(question) ? "usage" : "feedback";
  const out = await aistackChat(
    `Classify this question as exactly one word. "usage" if it asks about product analytics (counts, active users or accounts, adoption, trends over time), or "feedback" if it asks about what customers said (themes, requests, bugs, sentiment). Questions about what customers asked for are "feedback" even when they ask for a count, revenue or a time window.\n\nQuestion: ${question}\n\nAnswer with only "usage" or "feedback".`,
    { maxTokens: 4, temperature: 0, scope: "ask_classify" },
  );
  const v = out?.toLowerCase() ?? "";
  if (v.includes("usage")) return "usage";
  if (v.includes("feedback")) return "feedback";
  return heuristic; // null/ambiguous → trust the regex
}

export async function POST(req: Request) {
  const { workspace, user } = await getActiveSession();

  let body: { question?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  // Usage analytics needs both the AI stack and the usage_analytics entitlement.
  // Without it, every question goes to the feedback engine.
  const usageEnabled = hasFeature(workspace, "ai") && usageAnalyticsAllowed(workspace);
  const route = usageEnabled ? await classifyAsk(question) : "feedback";

  if (route === "usage") {
    const r = await askUsage(workspace, question);
    if (!r.ok) {
      const status = r.error === "ai_cap_reached" ? 429 : r.error === "not_entitled" ? 403 : 400;
      return NextResponse.json({ error: r.error }, { status });
    }
    return NextResponse.json({ answer: r.answer, citations: [], metric: r.metric, windowDays: r.windowDays });
  }

  const r = await askFeedback(workspace, question, user.id);
  if (!r.ok) {
    const status = r.error === "ai_cap_reached" ? 429 : r.error === "not_entitled" ? 403 : 400;
    return NextResponse.json({ error: r.error }, { status });
  }
  return NextResponse.json({ answer: r.answer, citations: r.citations });
}
