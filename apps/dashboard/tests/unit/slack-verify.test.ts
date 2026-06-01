import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "@/lib/slack/verify";

function sign(body: string, ts: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
}

describe("lib/slack/verify", () => {
  const secret = "shhh";
  const body = "token=x&team_id=T1&trigger_id=abc";
  const now = 1_700_000_000;

  it("accepts a valid signature within the window", () => {
    const ts = String(now);
    expect(verifySlackSignature(body, ts, sign(body, ts, secret), { secret, nowSec: now })).toBe(true);
  });

  it("rejects a bad signature", () => {
    const ts = String(now);
    expect(verifySlackSignature(body, ts, "v0=deadbeef", { secret, nowSec: now })).toBe(false);
  });

  it("rejects stale timestamps (replay window)", () => {
    const ts = String(now - 10_000);
    expect(verifySlackSignature(body, ts, sign(body, ts, secret), { secret, nowSec: now })).toBe(false);
  });

  it("rejects when secret or headers are missing", () => {
    expect(verifySlackSignature(body, null, "v0=x", { secret, nowSec: now })).toBe(false);
    expect(verifySlackSignature(body, String(now), "v0=x", { secret: "", nowSec: now })).toBe(false);
  });
});
