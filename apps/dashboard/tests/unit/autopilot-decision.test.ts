import { describe, it, expect } from "vitest";
import {
  classifyUnit,
  getThresholds,
  compositeType,
  modeForSource,
  unitExternalId,
  titleCase,
  type Thresholds,
} from "@/lib/feedback/decision";

// Default-ish thresholds for explicit, env-independent assertions.
const T: Thresholds = {
  merge: 0.9,
  suggest: 0.85,
  relevanceFloor: 0.3,
  promoteRelevance: 0.6,
  promoteConfidence: 0.6,
};

const base = {
  relevance: 0.8,
  confidence: 0.8,
  similarity: 0,
  hasMatch: false,
  hasValidEmail: true,
  hasAccountName: true,
};

describe("classifyUnit — the new & relevant gate", () => {
  it("drops units below the relevance floor (not real feedback)", () => {
    expect(classifyUnit({ ...base, relevance: 0.1 }, T)).toBe("drop");
  });

  it("drops even when a duplicate match exists (relevance wins first)", () => {
    expect(classifyUnit({ ...base, relevance: 0.05, hasMatch: true, similarity: 0.99 }, T)).toBe("drop");
  });

  it("attaches a near-identical match (>= merge) — not new", () => {
    expect(classifyUnit({ ...base, hasMatch: true, similarity: 0.93 }, T)).toBe("attach");
  });

  it("auto-promotes a novel, confident, mappable unit", () => {
    expect(classifyUnit({ ...base, similarity: 0, hasMatch: false }, T)).toBe("promote");
  });

  it("holds a borderline duplicate (suggest ≤ sim < merge)", () => {
    expect(classifyUnit({ ...base, hasMatch: true, similarity: 0.87 }, T)).toBe("hold");
  });

  it("holds a novel unit with low extraction confidence", () => {
    expect(classifyUnit({ ...base, confidence: 0.4 }, T)).toBe("hold");
  });

  it("holds a novel unit with mid relevance below the promote bar", () => {
    expect(classifyUnit({ ...base, relevance: 0.5 }, T)).toBe("hold");
  });

  it("holds when there is no usable submitter email (can't compose)", () => {
    expect(classifyUnit({ ...base, hasValidEmail: false }, T)).toBe("hold");
  });

  it("holds when no account can be resolved", () => {
    expect(classifyUnit({ ...base, hasAccountName: false }, T)).toBe("hold");
  });

  it("treats the merge boundary as inclusive and suggest-band as hold", () => {
    expect(classifyUnit({ ...base, hasMatch: true, similarity: 0.9 }, T)).toBe("attach");
    expect(classifyUnit({ ...base, hasMatch: true, similarity: 0.8999 }, T)).toBe("hold");
  });
});

describe("getThresholds — env overrides", () => {
  it("falls back to sane defaults when env is unset/invalid", () => {
    const t = getThresholds();
    expect(t.merge).toBeGreaterThan(t.suggest);
    expect(t.relevanceFloor).toBeGreaterThanOrEqual(0);
    expect(t.merge).toBeLessThanOrEqual(1);
  });

  it("reads a valid override and ignores an out-of-range one", () => {
    process.env.CRUMB_AUTOPILOT_MERGE_THRESHOLD = "0.95";
    process.env.CRUMB_AUTOPILOT_SUGGEST_THRESHOLD = "9"; // invalid → default
    const t = getThresholds();
    expect(t.merge).toBe(0.95);
    expect(t.suggest).toBe(0.85);
    delete process.env.CRUMB_AUTOPILOT_MERGE_THRESHOLD;
    delete process.env.CRUMB_AUTOPILOT_SUGGEST_THRESHOLD;
  });

  it("treats a blank value (compose env_file passthrough) as unset, not 0", () => {
    process.env.CRUMB_AUTOPILOT_MERGE_THRESHOLD = "";
    process.env.CRUMB_AUTOPILOT_RELEVANCE_FLOOR = " ";
    const t = getThresholds();
    expect(t.merge).toBe(0.9);
    expect(t.relevanceFloor).toBe(0.3);
    delete process.env.CRUMB_AUTOPILOT_MERGE_THRESHOLD;
    delete process.env.CRUMB_AUTOPILOT_RELEVANCE_FLOOR;
  });
});

describe("source/type/idempotency helpers", () => {
  it("maps each source to the right extraction mode", () => {
    expect(modeForSource("gong")).toBe("call");
    expect(modeForSource("intercom")).toBe("chat");
    expect(modeForSource("freshchat")).toBe("chat");
    expect(modeForSource("zendesk")).toBe("ticket");
    expect(modeForSource("freshdesk")).toBe("ticket");
  });

  it("clamps the item type to a compose-allowed value", () => {
    expect(compositeType("bug")).toBe("bug");
    expect(compositeType("question")).toBe("question");
    expect(compositeType("integration")).toBe("idea");
    expect(compositeType("idea")).toBe("idea");
  });

  it("builds a per-unit idempotency key", () => {
    expect(unitExternalId("12345", 0)).toBe("12345#0");
    expect(unitExternalId("call-abc", 3)).toBe("call-abc#3");
  });

  it("title-cases an account name derived from a domain", () => {
    expect(titleCase("acme")).toBe("Acme");
    expect(titleCase("")).toBe("");
  });
});
