import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/server";
import { askFeedback } from "@/lib/ai/ask";
import { askUsage } from "@/lib/ai/ask-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cloud-only "Ask" endpoint. Lives under ee/ so it's overlaid into app/ on
// cloud builds and stripped on community (404 on self-host). Two modes over
// one surface: "feedback" (RAG over the feedback corpus) and "usage" (a safe
// metric catalog over usage_events). Entitlement + monthly metering happen
// inside the lib (withAiBudget).

export async function POST(req: Request) {
  const { workspace, user } = await getActiveSession();

  let body: { question?: unknown; mode?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });
  const mode = body.mode === "usage" ? "usage" : "feedback";

  if (mode === "usage") {
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
