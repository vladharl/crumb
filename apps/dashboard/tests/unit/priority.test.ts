import { describe, it, expect } from "vitest";
import { priority, byPriorityDesc, formatArr, type PriorityInput } from "@/lib/priority";

const NOW = new Date("2026-06-19T00:00:00.000Z").getTime();

// A minimal open loop nobody has replied to, created "now" (no wait).
function input(over: Partial<PriorityInput> = {}): PriorityInput {
  return {
    arrAtStakeCents: 0,
    reachAccounts: 1,
    aiSeverity: null,
    status: "open",
    lastReplySide: null,
    createdAtIso: "2026-06-19T00:00:00.000Z",
    lastExternalReplyAtIso: null,
    ...over,
  };
}

describe("lib/priority", () => {
  describe("priority — revenue is the base unit", () => {
    it("scores the dollar value when no other signal is in play", () => {
      const p = priority(input({ arrAtStakeCents: 480_00_000 }), NOW); // $480k
      expect(p.score).toBe(480_000);
      expect(p.signalScore).toBe(0);
      expect(p.factors).toEqual([{ key: "revenue", label: "ARR at stake", delta: null }]);
    });

    it("ranks a larger account ahead of a smaller one, all else equal", () => {
      const big = priority(input({ arrAtStakeCents: 1_200_000_00 }), NOW); // $1.2M
      const small = priority(input({ arrAtStakeCents: 480_000_00 }), NOW); // $480k
      expect(big.score).toBeGreaterThan(small.score);
    });
  });

  describe("composite multipliers nudge within a revenue neighbourhood", () => {
    it("lets high severity lift a slightly-smaller account past a larger one", () => {
      // $480k critical vs $500k untriaged: the multiplier flips them.
      const critical = priority(input({ arrAtStakeCents: 480_000_00, aiSeverity: "critical" }), NOW);
      const plain = priority(input({ arrAtStakeCents: 500_000_00 }), NOW);
      expect(critical.score).toBeGreaterThan(plain.score);
    });

    it("cannot leapfrog an order-of-magnitude revenue gap", () => {
      // Every multiplier maxed still can't beat a 10x-larger plain account.
      const maxedSmall = priority(
        input({ arrAtStakeCents: 100_000_00, reachAccounts: 9, aiSeverity: "critical",
          lastReplySide: "customer", createdAtIso: "2026-01-01T00:00:00.000Z" }),
        NOW,
      );
      const plainBig = priority(input({ arrAtStakeCents: 1_000_000_00 }), NOW);
      expect(plainBig.score).toBeGreaterThan(maxedSmall.score);
    });

    it("reads reach back as a bounded percentage and caps it", () => {
      const three = priority(input({ arrAtStakeCents: 100_000_00, reachAccounts: 3 }), NOW);
      expect(three.factors.find(f => f.key === "reach")?.delta).toBe("+40%");
      const many = priority(input({ arrAtStakeCents: 100_000_00, reachAccounts: 50 }), NOW);
      expect(many.factors.find(f => f.key === "reach")?.delta).toBe("+100%"); // capped
    });
  });

  describe("graceful degradation (self-host / untriaged)", () => {
    it("omits severity entirely when aiSeverity is null", () => {
      const p = priority(input({ arrAtStakeCents: 100_000_00, aiSeverity: null }), NOW);
      expect(p.severityActive).toBe(false);
      expect(p.factors.some(f => f.key === "severity")).toBe(false);
    });

    it("treats low severity as neutral (no lift, not shown)", () => {
      const p = priority(input({ arrAtStakeCents: 100_000_00, aiSeverity: "low" }), NOW);
      expect(p.severityActive).toBe(false);
      expect(p.factors.some(f => f.key === "severity")).toBe(false);
    });
  });

  describe("customer wait only counts while it's our turn", () => {
    const old = "2026-06-01T00:00:00.000Z"; // 18 days before NOW

    it("adds a wait bonus when the customer is waiting on us", () => {
      const p = priority(input({ arrAtStakeCents: 100_000_00, createdAtIso: old }), NOW);
      const wait = p.factors.find(f => f.key === "wait");
      expect(wait?.label).toBe("waiting 18 days");
      expect(wait?.delta).toBe("+30%");
    });

    it("ignores wait when the vendor replied last (ball in customer's court)", () => {
      const p = priority(
        input({ arrAtStakeCents: 100_000_00, createdAtIso: old, lastReplySide: "vendor" }),
        NOW,
      );
      expect(p.factors.some(f => f.key === "wait")).toBe(false);
    });

    it("ignores wait on a closed loop", () => {
      const p = priority(
        input({ arrAtStakeCents: 100_000_00, createdAtIso: old, status: "shipped" }),
        NOW,
      );
      expect(p.factors.some(f => f.key === "wait")).toBe(false);
    });
  });

  describe("zero-ARR items don't silently sink", () => {
    it("orders $0 items by their non-revenue signal, not creation order", () => {
      const loud = priority(input({ arrAtStakeCents: 0, reachAccounts: 5, aiSeverity: "critical" }), NOW);
      const quiet = priority(input({ arrAtStakeCents: 0 }), NOW);
      expect(loud.score).toBe(0);
      expect(quiet.score).toBe(0);
      // Same score, but the loud one wins the comparator via signalScore.
      expect(loud.signalScore).toBeGreaterThan(quiet.signalScore);
      expect(byPriorityDesc(
        { ...loud, createdAtIso: "2026-06-01T00:00:00.000Z" },
        { ...quiet, createdAtIso: "2026-06-19T00:00:00.000Z" },
      )).toBeLessThan(0); // loud sorts first despite being older
    });

    it("labels the missing-ARR case instead of pretending it's $0 of value", () => {
      const p = priority(input({ arrAtStakeCents: 0 }), NOW);
      expect(p.factors[0]).toEqual({ key: "revenue", label: "ARR not set", delta: null });
    });
  });

  describe("byPriorityDesc", () => {
    it("sorts highest score first", () => {
      const a = { ...priority(input({ arrAtStakeCents: 500_000_00 }), NOW), createdAtIso: "2026-06-19T00:00:00.000Z" };
      const b = { ...priority(input({ arrAtStakeCents: 100_000_00 }), NOW), createdAtIso: "2026-06-19T00:00:00.000Z" };
      expect([b, a].sort(byPriorityDesc)[0]).toBe(a);
    });
  });

  describe("formatArr", () => {
    it("formats millions, thousands, and small values", () => {
      expect(formatArr(1_200_000_00)).toBe("$1.2M");
      expect(formatArr(480_000_00)).toBe("$480k");
      expect(formatArr(5_000_00)).toBe("$5k"); // $5,000 → thousands step
      expect(formatArr(500_00)).toBe("$500"); // below $1,000 → exact dollars
    });
    it("never shows $0k or $1k for amounts under $1k", () => {
      expect(formatArr(400_00)).toBe("$400"); // the old copies said "$0k"
      expect(formatArr(999_00)).toBe("$999"); // …and "$1k" here
      expect(formatArr(1_00)).toBe("$1");
      expect(formatArr(999_50)).toBe("$1k"); // rounds up to a whole thousand
      expect(formatArr(1_499_00)).toBe("$1k");
    });
    it("rolls a rounded 1000k over to millions", () => {
      expect(formatArr(999_499_00)).toBe("$999k");
      expect(formatArr(999_500_00)).toBe("$1.0M");
      expect(formatArr(1_000_000_00)).toBe("$1.0M");
    });
    it("has one zero state, never $0", () => {
      expect(formatArr(0)).toBe("ARR not set");
      expect(formatArr(-1)).toBe("ARR not set");
      expect(formatArr(Number.NaN)).toBe("ARR not set");
    });
    it("appends a suffix to amounts but not to the zero state", () => {
      expect(formatArr(480_000_00, " ARR")).toBe("$480k ARR");
      expect(formatArr(500_00, " at stake")).toBe("$500 at stake");
      expect(formatArr(0, " ARR")).toBe("ARR not set");
    });
    it("lets a subset sum read $0 instead of ARR not set", () => {
      expect(formatArr(0, "", "$0")).toBe("$0");
      expect(formatArr(480_000_00, "", "$0")).toBe("$480k");
    });
    it("keeps two decimals of millions where asked (the printed QBR)", () => {
      expect(formatArr(2_349_000_00, "", undefined, 2)).toBe("$2.35M");
      expect(formatArr(1_250_000_00, " ARR", undefined, 2)).toBe("$1.25M ARR");
      expect(formatArr(999_500_00, "", undefined, 2)).toBe("$1.00M");
      expect(formatArr(480_000_00, "", undefined, 2)).toBe("$480k"); // only millions change
      expect(formatArr(0, "", undefined, 2)).toBe("ARR not set");
    });
  });
});
