import { describe, it, expect } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  CLOSED_STATUSES, OPEN_STATUSES, STATUS_LABELS, VENDOR_STATUSES, VENDOR_STATUS_OPTIONS,
} from "@crumb/ui";
import { loopTurn, waitingSince, waitingDays, LOOP_CLOSED_STATUSES } from "@/lib/loop";
import { loopOpenSql, notMergedSql } from "@/lib/loop-sql";

describe("shared status sets (@crumb/ui)", () => {
  const all = Object.keys(STATUS_LABELS);

  it("labels all nine statuses", () => {
    expect(all).toEqual(["open", "review", "planned", "progress", "shipped", "declined", "deferred", "duplicate", "resolved"]);
  });

  it("puts every status in exactly one of OPEN or CLOSED", () => {
    for (const s of all) expect(OPEN_STATUSES.has(s) !== CLOSED_STATUSES.has(s)).toBe(true);
    expect(OPEN_STATUSES.size + CLOSED_STATUSES.size).toBe(all.length);
    expect(OPEN_STATUSES.has("deferred")).toBe(true);
  });

  it("treats resolved as closed but never vendor-settable", () => {
    expect(CLOSED_STATUSES.has("resolved")).toBe(true);
    expect(VENDOR_STATUSES).not.toContain("resolved");
    expect(VENDOR_STATUS_OPTIONS.map(o => o.value)).not.toContain("resolved");
  });

  it("offers the other eight to vendors in picker order, with the shared labels", () => {
    expect(VENDOR_STATUSES).toEqual(all.filter(s => s !== "resolved"));
    expect(VENDOR_STATUS_OPTIONS).toEqual(VENDOR_STATUSES.map(value => ({ value, label: STATUS_LABELS[value] })));
  });

  it("drives the inbox buckets from the shared closed set", () => {
    expect([...LOOP_CLOSED_STATUSES]).toEqual([...CLOSED_STATUSES]);
  });
});

describe("lib/loop-sql", () => {
  const render = (q: SQL) => new PgDialect().sqlToQuery(q);

  it("filters on the shared closed set", () => {
    const open = render(loopOpenSql(sql`i.status`));
    expect(open.sql).toBe("i.status not in ($1, $2, $3, $4)");
    expect(open.params).toEqual([...CLOSED_STATUSES]);

    expect(render(notMergedSql(sql`i.merged_into_id`)).sql).toBe("i.merged_into_id is null");
  });
});

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
