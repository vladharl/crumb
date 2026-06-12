import { describe, it, expect } from "vitest";
import { loopTurn, waitingSince, waitingDays, LOOP_CLOSED_STATUSES } from "@/lib/loop";

describe("lib/loop", () => {
  describe("loopTurn", () => {
    it("is the vendor's turn when nobody has replied yet", () => {
      expect(loopTurn({ status: "open", lastReplySide: null })).toBe("yours");
    });

    it("is the vendor's turn when the customer spoke last", () => {
      expect(loopTurn({ status: "open", lastReplySide: "customer" })).toBe("yours");
      expect(loopTurn({ status: "progress", lastReplySide: "customer" })).toBe("yours");
    });

    it("is waiting when the vendor spoke last", () => {
      expect(loopTurn({ status: "open", lastReplySide: "vendor" })).toBe("waiting");
      expect(loopTurn({ status: "planned", lastReplySide: "vendor" })).toBe("waiting");
    });

    it("closes on terminal statuses regardless of who spoke last", () => {
      for (const status of LOOP_CLOSED_STATUSES) {
        expect(loopTurn({ status, lastReplySide: null })).toBe("closed");
        expect(loopTurn({ status, lastReplySide: "customer" })).toBe("closed");
        expect(loopTurn({ status, lastReplySide: "vendor" })).toBe("closed");
      }
    });

    it("treats non-terminal statuses as open loops", () => {
      for (const status of ["open", "review", "planned", "progress", "deferred"]) {
        expect(loopTurn({ status, lastReplySide: null })).toBe("yours");
      }
    });
  });

  describe("waitingSince", () => {
    const created = "2026-06-01T00:00:00.000Z";
    const replied = "2026-06-05T00:00:00.000Z";

    it("starts at item creation when nobody has replied", () => {
      expect(waitingSince({ createdAtIso: created, lastReplySide: null, lastExternalReplyAtIso: null })).toBe(created);
    });

    it("restarts at the customer's last message when they replied last", () => {
      expect(waitingSince({ createdAtIso: created, lastReplySide: "customer", lastExternalReplyAtIso: replied })).toBe(replied);
    });

    it("falls back to creation when the vendor replied last (not a waiting state)", () => {
      expect(waitingSince({ createdAtIso: created, lastReplySide: "vendor", lastExternalReplyAtIso: replied })).toBe(created);
    });
  });

  describe("waitingDays", () => {
    it("converts the wait into fractional days", () => {
      const since = "2026-06-01T00:00:00.000Z";
      const now = new Date("2026-06-08T12:00:00.000Z").getTime();
      expect(waitingDays(since, now)).toBeCloseTo(7.5);
    });

    it("clamps future timestamps to zero", () => {
      const since = "2026-06-09T00:00:00.000Z";
      const now = new Date("2026-06-08T00:00:00.000Z").getTime();
      expect(waitingDays(since, now)).toBe(0);
    });
  });
});
