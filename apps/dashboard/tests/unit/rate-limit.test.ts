import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkRateLimit } from "@/lib/rate-limit";

// Tests run against a module-scoped in-memory Map keyed on test-unique
// strings so each test owns its own bucket and they don't interact.
let testCounter = 0;
function key(): string {
  return `vitest:rate-limit:${++testCounter}`;
}

describe("lib/rate-limit checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first request and decrements remaining", () => {
    const r = checkRateLimit(key(), { capacity: 5, refillPerSec: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remaining).toBe(4);
  });

  it("blocks once the bucket is drained", () => {
    const k = key();
    // Drain capacity-2 in burst.
    for (let i = 0; i < 2; i++) {
      const r = checkRateLimit(k, { capacity: 2, refillPerSec: 0.01 });
      expect(r.ok).toBe(true);
    }
    const blocked = checkRateLimit(k, { capacity: 2, refillPerSec: 0.01 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills after the configured rate over elapsed time", () => {
    const k = key();
    // Drain a capacity-3 bucket.
    for (let i = 0; i < 3; i++) checkRateLimit(k, { capacity: 3, refillPerSec: 1 });
    expect(checkRateLimit(k, { capacity: 3, refillPerSec: 1 }).ok).toBe(false);

    // Advance 2 seconds → 2 tokens refilled.
    vi.advanceTimersByTime(2000);
    expect(checkRateLimit(k, { capacity: 3, refillPerSec: 1 }).ok).toBe(true);
    expect(checkRateLimit(k, { capacity: 3, refillPerSec: 1 }).ok).toBe(true);
    // 3rd in a row exceeds the 2 refilled tokens.
    expect(checkRateLimit(k, { capacity: 3, refillPerSec: 1 }).ok).toBe(false);
  });

  it("each key has its own independent bucket", () => {
    const a = key();
    const b = key();
    // Drain `a` fully.
    for (let i = 0; i < 2; i++) checkRateLimit(a, { capacity: 2, refillPerSec: 0.01 });
    expect(checkRateLimit(a, { capacity: 2, refillPerSec: 0.01 }).ok).toBe(false);
    // `b` is untouched.
    expect(checkRateLimit(b, { capacity: 2, refillPerSec: 0.01 }).ok).toBe(true);
  });
});
