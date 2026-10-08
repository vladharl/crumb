import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/server";
import { hasFeature, usageAnalyticsAllowed } from "@/lib/entitlements";
import { askFeedback } from "@/lib/ai/ask";
import { askUsage } from "@/lib/ai/ask-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cloud-only "Ask" endpoint. Lives under ee/ so it's overlaid into app/ on
// cloud builds and stripped on community (404 on self-host). One smart box: the
// server auto-routes each question to "feedback" (RAG over the feedback corpus)
// or "usage" (a safe metric catalog over usage_events). Entitlement + monthly
// metering happen inside the lib (withAiBudget).

// Strong usage signals.
const USAGE_RE = /\b(how many|how much|active (users|accounts)|adoption|trend(ing)?|usage|used|using|count of|number of|\bMAU\b|\bDAU\b|last (week|month|\d+ days)|past \d+ days)\b/i;
// Words that make a counting, revenue or time question about what customers
// asked for ("how much ARR is asking for SSO?", "how many requests last
// month?"). The feedback engine answers those from SQL totals.
const FEEDBACK_RE = /\b(feedback|requests?|requested|ask(s|ed|ing)? for|asking|want(s|ed)?|bugs?|complain\w*|said|mention\w*)\b/i;

// Decide feedback vs usage: "usage" on a usage signal with no feedback word,
// otherwise "feedback" (broadly applicable, safe).
// ponytail: keywords only. The LLM router this replaces had a 4-token budget,
// which a reasoning model spends thinking, so the regex decided anyway, one
// model round trip later. Route with a model (a few hundred tokens) if the
// regex misroutes.
function classifyAsk(question: string): "feedback" | "usage" {
  return USAGE_RE.test(question) && !FEEDBACK_RE.test(question) ? "usage" : "feedback";
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
  const route = usageEnabled ? classifyAsk(question) : "feedback";

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
