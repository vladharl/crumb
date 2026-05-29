import { describe, it, expect } from "vitest";
import { REPLAY_CAPS } from "@/lib/replay/ingest";

// The whole point of these constants is cost containment — if the numbers
// drift without intent we want a red CI rather than a $4k storage bill.
// Pin them, then update both the test and the README capability copy
// whenever they actually need to change.
describe("lib/replay/ingest REPLAY_CAPS", () => {
  it("caps storage at 10 MB / session", () => {
    expect(REPLAY_CAPS.maxSizeBytes).toBe(10 * 1024 * 1024);
  });

  it("caps event count at 5000 / session", () => {
    expect(REPLAY_CAPS.maxEventCount).toBe(5000);
  });

  it("caps duration at 30 minutes", () => {
    expect(REPLAY_CAPS.maxDurationMs).toBe(30 * 60 * 1000);
  });

  it("keeps the size cap below what the widget bundle ships with so a single chunk can't immediately blow it", () => {
    // The recorder's flush threshold is 50 events; even a worst-case event
    // averaging 4 KB lands at 200 KB per chunk — well under the session
    // cap. This is a sanity gate, not a contract.
    expect(REPLAY_CAPS.maxSizeBytes).toBeGreaterThan(1024 * 1024); // > 1 MB
  });
});
