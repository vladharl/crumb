import "server-only";
import type { Workspace } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { hasFeature } from "@/lib/entitlements";
import { consumeAi } from "@/lib/usage";

// Shared AI gate→meter→run plumbing for the Cloud-only AI features. This module
// imports only tier/entitlements/usage (no aistack client), so it's safe in the
// community bundle and is NOT module-replaced — the gate simply returns
// "not_entitled" on self-host (hasFeature is hard-false there).

type WsForAi = Pick<Workspace, "id" | "planId" | "subscriptionStatus">;

export type AiBudgetError = "not_entitled" | "ai_cap_reached";
export type AiBudgetResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AiBudgetError };

// Check the workspace is AI-entitled, atomically consume one monthly AI unit,
// then run `fn`. One call = one metered unit regardless of how many model calls
// `fn` makes internally (e.g. triage + embedding at capture share a unit).
// Counts before the work (like consumeAi) so a cost ceiling holds even if the
// model call later fails.
export async function withAiBudget<T>(
  ws: WsForAi,
  fn: () => Promise<T>,
): Promise<AiBudgetResult<T>> {
  if (!isCloud() || !hasFeature(ws, "ai")) return { ok: false, error: "not_entitled" };
  const consumed = await consumeAi(ws);
  if (!consumed.ok) return { ok: false, error: "ai_cap_reached" };
  const value = await fn();
  return { ok: true, value };
}

// Extract the first {...} object from a model response, tolerating reasoning
// preamble and ```json fences (qwen leaks both). Returns null on no match or
// parse failure. This is the single-line-JSON convention used by every AI
// feature here (cluster.ts / ticket.ts inline the same logic).
export function parseJsonLine<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  const cleaned = (m ? m[0] : text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
