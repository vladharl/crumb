import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { log } from "@/lib/log";

// Capture stdout/stderr writes (the logger uses console.log/console.error).
function capture() {
  const lines: Array<{ stream: "out" | "err"; obj: any }> = [];
  const out = vi.spyOn(console, "log").mockImplementation((l: string) => {
    lines.push({ stream: "out", obj: JSON.parse(l) });
  });
  const err = vi.spyOn(console, "error").mockImplementation((l: string) => {
    lines.push({ stream: "err", obj: JSON.parse(l) });
  });
  return { lines, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

describe("lib/log", () => {
  const orig = process.env.CRUMB_LOG_LEVEL;
  beforeEach(() => { process.env.CRUMB_LOG_LEVEL = "debug"; });
  afterEach(() => { process.env.CRUMB_LOG_LEVEL = orig; });

  it("emits a JSON line with time/level/msg and extra fields", () => {
    const c = capture();
    log.info("hello", { scope: "crumb/test", n: 42 });
    c.restore();
    expect(c.lines).toHaveLength(1);
    const { obj, stream } = c.lines[0];
    expect(stream).toBe("out");
    expect(obj.level).toBe("info");
    expect(obj.msg).toBe("hello");
    expect(obj.scope).toBe("crumb/test");
    expect(obj.n).toBe(42);
    expect(typeof obj.time).toBe("string");
  });

  it("serializes an Error into name/message/stack under err", () => {
    const c = capture();
    log.error("boom", { err: new Error("kaboom") });
    c.restore();
    const { obj, stream } = c.lines[0];
    expect(stream).toBe("err");
    expect(obj.err.name).toBe("Error");
    expect(obj.err.message).toBe("kaboom");
    expect(typeof obj.err.stack).toBe("string");
  });

  it("respects CRUMB_LOG_LEVEL — drops below threshold", () => {
    process.env.CRUMB_LOG_LEVEL = "warn";
    const c = capture();
    log.debug("nope");
    log.info("nope");
    log.warn("yes");
    log.error("yes");
    c.restore();
    expect(c.lines.map(l => l.obj.msg)).toEqual(["yes", "yes"]);
  });

  it("routes warn/error to stderr and info/debug to stdout", () => {
    const c = capture();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    c.restore();
    const byMsg = Object.fromEntries(c.lines.map(l => [l.obj.msg, l.stream]));
    expect(byMsg).toEqual({ d: "out", i: "out", w: "err", e: "err" });
  });
});
