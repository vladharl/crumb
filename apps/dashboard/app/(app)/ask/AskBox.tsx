"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Btn, Card, Ic, Pill } from "@crumb/ui";

// One mixed list — the server auto-routes feedback vs usage questions.
const EXAMPLES: string[] = [
  "What do enterprise accounts want before renewal?",
  "Which bugs are blocking the most customers?",
  "How many accounts were active in the last 30 days?",
  "What integrations are people asking for?",
  "Is adoption of the new dashboard trending up?",
];

function errText(code: string | undefined, status: number): string {
  switch (code) {
    case "no_data":        return "There's no feedback to search yet.";
    case "not_entitled":   return "AI features aren't enabled on this workspace.";
    case "unclear":        return "Couldn't map that to a usage metric. Try naming a tracked event, e.g. \"how many accounts used export last week?\"";
    case "embed_failed":
    case "answer_failed":  return "Couldn't generate an answer. Try rephrasing.";
    default:               return status === 404 ? "Ask isn't available on this deployment." : "Something went wrong. Try again.";
  }
}

// notice: this month's AI-budget banner (null under 80%). capNotice: the
// "paused until" notice, swapped in when a question hits the cap. Both are
// rendered by the page (they read the plan + role on the server).
export function AskBox({ usageEnabled = false, notice, capNotice }: {
  usageEnabled?: boolean;
  notice?: ReactNode;
  capNotice?: ReactNode;
}) {
  // usageEnabled retained for API compatibility; routing is now server-side.
  void usageEnabled;
  const [capped, setCapped] = useState(false);
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<{ shortId: string; title: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;
    setQ(trimmed);
    start(async () => {
      setError(null);
      setAnswer(null);
      setCitations([]);
      setAsked(trimmed);
      try {
        const res = await fetch("/api/v1/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: trimmed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data?.error === "ai_cap_reached") setCapped(true);
          else setError(errText(data?.error, res.status));
          return;
        }
        setAnswer(typeof data.answer === "string" ? data.answer : "");
        setCitations(Array.isArray(data.citations) ? data.citations : []);
      } catch {
        setError("Something went wrong. Try again.");
      }
    });
  }

  return (
    <div className="col gap-4">
      {capped ? capNotice : notice}
      <Card>
        <div className="card-body col gap-3">
          <div className="row gap-2 center" style={{
            border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 12px",
          }}>
            <Ic.sparkle style={{ width: 14, height: 14, color: "var(--accent-deep)", flexShrink: 0 }} />
            <input
              className="input"
              placeholder="Ask anything about your feedback or usage…"
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") ask(q); }}
              disabled={pending}
              style={{ border: 0, padding: 0, flex: 1 }}
            />
            <Btn sm variant="primary" onClick={() => ask(q)} disabled={pending || !q.trim()}>
              {pending ? "Thinking…" : "Ask"}
            </Btn>
          </div>
          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            {EXAMPLES.map(ex => (
              <button
                key={ex}
                type="button"
                className="text-xs"
                onClick={() => ask(ex)}
                disabled={pending}
                style={{
                  border: "var(--border)", borderRadius: 999, padding: "4px 10px",
                  background: "var(--surface)", color: "var(--mute)", cursor: "pointer",
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {error && (
        <Card><div className="card-body"><span className="text-sm" style={{ color: "var(--err-text)" }}>{error}</span></div></Card>
      )}

      {answer !== null && (
        <Card>
          <div className="card-body col gap-3">
            {asked && <span className="eyebrow">{asked}</span>}
            <p className="text-md" style={{ margin: 0, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{answer}</p>
            {citations.length > 0 && (
              <div className="col gap-2" style={{ borderTop: "var(--border)", paddingTop: 12 }}>
                <span className="eyebrow">Sources</span>
                <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                  {citations.map(c => (
                    <Link key={c.shortId} href={`/thread/${c.shortId}`} style={{ textDecoration: "none" }}>
                      <Pill ring><span className="mono">{c.shortId}</span> · {c.title.length > 40 ? c.title.slice(0, 39) + "…" : c.title}</Pill>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
