// Pure core of the Autopilot gate — NO DB / I/O / server-only imports, so it's
// directly unit-testable and safe to import anywhere. The DB-bound orchestration
// lives in lib/feedback/ingest.ts, which re-uses these helpers.

import type { CaptureSource } from "@/lib/captures";
import type { ExtractMode } from "@/lib/ai/extract-feedback";

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : def;
}

export type Thresholds = {
  merge: number; // similarity ≥ this ⇒ same request (attach, not new)
  suggest: number; // similarity ≥ this ⇒ a candidate worth flagging
  relevanceFloor: number; // relevance < this ⇒ drop
  promoteRelevance: number; // auto-promote needs relevance ≥ this …
  promoteConfidence: number; // … and confidence ≥ this
};

// Tunable without a redeploy of the logic (mirrors CRUMB_DEDUP_THRESHOLD).
export function getThresholds(): Thresholds {
  return {
    merge: envNum("CRUMB_AUTOPILOT_MERGE_THRESHOLD", 0.9),
    suggest: envNum("CRUMB_AUTOPILOT_SUGGEST_THRESHOLD", 0.85),
    relevanceFloor: envNum("CRUMB_AUTOPILOT_RELEVANCE_FLOOR", 0.3),
    promoteRelevance: envNum("CRUMB_AUTOPILOT_PROMOTE_RELEVANCE", 0.6),
    promoteConfidence: envNum("CRUMB_AUTOPILOT_PROMOTE_CONFIDENCE", 0.6),
  };
}

export type UnitDecision = "drop" | "attach" | "promote" | "hold";

// The "new & relevant?" decision. `similarity` is the best candidate's cosine
// score (0 if none); `hasMatch` means a candidate at/above the suggest floor
// exists.
//   relevance < floor                   → drop   (not real feedback)
//   match & similarity ≥ merge          → attach (not new)
//   novel & confident & mappable        → promote (create the item now)
//   otherwise (borderline / unmappable) → hold   (human review)
export function classifyUnit(
  input: {
    relevance: number;
    confidence: number;
    similarity: number;
    hasMatch: boolean;
    hasValidEmail: boolean;
    hasAccountName: boolean;
  },
  t: Thresholds = getThresholds(),
): UnitDecision {
  if (input.relevance < t.relevanceFloor) return "drop";
  if (input.hasMatch && input.similarity >= t.merge) return "attach";
  const novel = !input.hasMatch;
  const promotable =
    novel &&
    input.hasValidEmail &&
    input.hasAccountName &&
    input.relevance >= t.promoteRelevance &&
    input.confidence >= t.promoteConfidence;
  return promotable ? "promote" : "hold";
}

// Which extraction prompt a source uses: tickets vs chats vs call transcripts.
export function modeForSource(source: CaptureSource): ExtractMode {
  switch (source) {
    case "gong":
      return "call";
    case "intercom":
    case "freshchat":
      return "chat";
    default:
      return "ticket"; // zendesk | freshdesk (+ any future ticketing source)
  }
}

// composeItem only accepts bug|idea|question; map the richer extraction type in.
export function compositeType(type: string): string {
  return type === "bug" || type === "question" ? type : "idea";
}

// Per-unit idempotency key: one record can yield several units (a Gong call), so
// we suffix the provider id with the unit index. Matches the unique
// (workspace, source, external_id) index.
export function unitExternalId(recordExternalId: string, idx: number): string {
  return `${recordExternalId}#${idx}`;
}

export function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
