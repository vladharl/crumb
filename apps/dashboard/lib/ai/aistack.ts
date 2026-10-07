import "server-only";
import { log } from "@/lib/log";

// Shared client for the aistack OpenAI-compatible chat endpoint. Both
// lib/ai/cluster.ts and lib/ai/ticket.ts (the cloud-edition wrappers) call
// through here so the fetch/auth/parse plumbing lives in one place. The
// community edition never imports this module — those wrappers are swapped
// for SDK-free stubs at build time (see next.config.mjs), so nothing aistack
// enters the self-host bundle.

const DEFAULT_MODEL = "qwen-35b-8bit";
const DEFAULT_BASE_URL = "https://aistack.eissa.cloud/v1";
// qwen-35b-8bit is a 36 GB build; aistack keeps one large chat model resident
// and cold-loads on a model switch, so the first call after an eviction can be
// slow. Bound it generously rather than hanging a fire-and-forget cluster call.
const TIMEOUT_MS = 120_000;

// Resolved once at import. Model is overridable for experimentation; key and
// base URL are read per-call so a late-set env (tests, lazy config) still works.
export const AISTACK_MODEL = process.env.AISTACK_MODEL?.trim() || DEFAULT_MODEL;

export function aistackConfigured(): boolean {
  return !!process.env.AISTACK_API_KEY?.trim();
}

// House style: no em-dashes in anything people read. Prompts whose output is
// shown to someone carry this rule; aistackChat enforces it on every reply.
export const NO_EM_DASH_RULE = "Never use em-dashes (—). Use a comma, a period or parentheses instead.";

// Dash punctuation in model output becomes a comma: an em-dash (raw, or as a
// unicode escape inside JSON) or an en-dash with spaces around it. A dash
// that opens a line or meets other punctuation is dropped. Ranges like 2–5
// and 9:00 – 17:00 stay.
export function noEmDash(text: string): string {
  return text
    .replace(/\\u2014/gi, "—")
    .replace(/(?<!\d)[ \t]+–[ \t]+(?!\d)/g, " — ")
    .replace(/^[ \t]*—[ \t]*/gm, "")
    .replace(/[ \t]*—[ \t]*(?=[.,;:!?)]|$)/gm, "")
    .replace(/[ \t]*—[ \t]*/g, ", ");
}

// Single-turn chat completion. Returns the assistant message content, or null
// on missing key / non-2xx / timeout / network error — callers treat null as
// "no suggestion" and never throw (both AI features are best-effort).
export async function aistackChat(
  prompt: string,
  opts: { maxTokens: number; temperature: number; scope: string },
): Promise<string | null> {
  const key = process.env.AISTACK_API_KEY?.trim();
  if (!key) return null;
  const base = (process.env.AISTACK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: AISTACK_MODEL,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        // Portal extension: don't offer web_search/fetch_url. These are
        // classification/drafting calls — tool loops would add latency and
        // non-determinism for no benefit.
        tools_enabled: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      log.error("aistack chat failed", { scope: opts.scope, status: resp.status });
      return null;
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    // qwen is a reasoning model: thinking tokens land in message.reasoning
    // (non-streaming), so message.content is the clean final answer.
    const text = noEmDash((data.choices?.[0]?.message?.content ?? "").trim()).trim();
    return text || null;
  } catch (err) {
    log.error("aistack chat error", { scope: opts.scope, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
