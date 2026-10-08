import { describe, it, expect } from "vitest";
import { CLOSED_STATUSES, OPEN_STATUSES, STATUS_LABELS } from "@crumb/ui";
import { statusMix } from "@/lib/insights/status-mix";

const OPEN_BUCKETS = ["open", "progress", "deferred"] as const;
const CLOSED_BUCKETS = ["shipped", "declined", "otherClosed"] as const;

describe("lib/insights/statusMix", () => {
  it("puts every status in one bucket on the matching side of the loop", () => {
    for (const status of Object.keys(STATUS_LABELS)) {
      const mix = statusMix([{ status, count: 1 }]);
      const open = OPEN_BUCKETS.filter(b => mix[b] === 1);
      const closed = CLOSED_BUCKETS.filter(b => mix[b] === 1);
      expect(open.length + closed.length, status).toBe(1);
      expect(open.length === 1, status).toBe(OPEN_STATUSES.has(status));
      expect(closed.length === 1, status).toBe(CLOSED_STATUSES.has(status));
    }
  });

  it("keeps declined and deferred apart, and the buckets add up to the total", () => {
    const rows = Object.keys(STATUS_LABELS).map((status, i) => ({ status, count: i + 1 }));
    expect(statusMix(rows)).toEqual({
      open: 1 + 2,          // open, review
      progress: 3 + 4,      // planned, progress
      shipped: 5,
      declined: 6,
      deferred: 7,
      otherClosed: 8 + 9,   // duplicate, resolved
      total: 45,
    });
  });

  it("counts an unknown status as an open loop", () => {
    expect(statusMix([{ status: "mystery", count: 2 }])).toMatchObject({ open: 2, total: 2 });
    expect(statusMix([]).total).toBe(0);
  });
});
