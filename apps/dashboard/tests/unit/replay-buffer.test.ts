import { beforeAll, describe, expect, it, vi } from "vitest";
import type { eventWithTime } from "rrweb";
import type { Stretch } from "../../../widget/src/widget-record";

// Session replay from before the customer consents (audit #75). The recorder
// used to start only when they ticked the box in the form, after the bug, and
// couldn't restart once unticked. Now it loads with the page and keeps the
// last two minutes in memory, sending nothing; consent sends those first and
// records on; unticking stops and drops what wasn't sent; ticking again starts
// a fresh session, as does each report the recording is linked to.

// rrweb needs a DOM; the fake hands its emit callback to the test and keeps
// the options each start used.
const rr = vi.hoisted(() => ({
  emit: (_e: unknown, _checkout?: boolean) => {},
  starts: [] as Array<{ checkoutEveryNms?: number }>,
}));
vi.mock("rrweb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("rrweb")>()),
  record: (opts: { emit: (e: unknown, checkout?: boolean) => void; checkoutEveryNms?: number }) => {
    rr.emit = opts.emit;
    rr.starts.push(opts);
    return () => {};
  },
}));

const listeners: Record<string, () => void> = {};
const store = new Map<string, string>();
const sent = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 201 }));
let rec: typeof import("../../../widget/src/widget-record");
let widget: typeof import("../../../widget/src/widget");
beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; } });
  // No <script> tag for widget.ts to find, so it stops after its API stub.
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, currentScript: null, scripts: [] });
  vi.stubGlobal("location", { href: "https://app.test/billing" });
  vi.stubGlobal("screen", { width: 1440, height: 900 });
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal("fetch", sent);
  rec = await import("../../../widget/src/widget-record");
  widget = await import("../../../widget/src/widget");
});

const META = 4, FULL = 2, INC = 3;
const ev = (type: number, timestamp: number, data: object = {}) => ({ type, timestamp, data }) as unknown as eventWithTime;
const MIN = 60_000;

describe("the pre-consent window", () => {
  it("keeps the last two minutes, dropping old stretches whole at a snapshot", () => {
    const w: Stretch[] = [];
    for (const e of [ev(META, 0), ev(FULL, 0), ev(INC, 30_000)]) rec.keepRecent(w, e);
    // rrweb's checkout a minute in: a Meta, then its full snapshot, both flagged.
    rec.keepRecent(w, ev(META, MIN), true);
    rec.keepRecent(w, ev(FULL, MIN), true);
    rec.keepRecent(w, ev(INC, 90_000));
    rec.keepRecent(w, ev(META, 2 * MIN), true);
    rec.keepRecent(w, ev(FULL, 2 * MIN), true);
    // At 2:00 the first stretch is still needed for the window.
    expect(w.map(s => s.at)).toEqual([0, MIN, 2 * MIN]);
    // At 3:00 the stretch from 1:00 covers it alone.
    rec.keepRecent(w, ev(INC, 3 * MIN));
    expect(w.map(s => s.at)).toEqual([MIN, 2 * MIN]);
    expect(w[0]!.events.map(e => e.type)).toEqual([META, FULL, INC]);
  });

  it("stays within its caps: a stretch over them alone keeps its start until the next snapshot", () => {
    const w: Stretch[] = [];
    rec.keepRecent(w, ev(META, 0));
    rec.keepRecent(w, ev(FULL, 0));
    for (let i = 1; i <= 1200; i++) rec.keepRecent(w, ev(INC, i));
    expect(w).toHaveLength(1);
    expect(w[0]!.events).toHaveLength(1000);
    expect(w[0]!.full).toBe(true);

    rec.keepRecent(w, ev(META, 2000), true); // the full stretch makes room
    expect(w.map(s => s.at)).toEqual([2000]);
    rec.keepRecent(w, ev(FULL, 2000, { node: "x".repeat(3 * 1024 * 1024) }), true); // over 2 MB on its own
    rec.keepRecent(w, ev(INC, 2001)); // replay can't skip events mid-stretch
    expect(w[0]!.events).toHaveLength(1);
  });
});

describe("consent", () => {
  const opts = { apiBase: "https://crumb.test", workspaceSlug: "acme" };
  const chunks = () => sent.mock.calls.map(([url, init]) => ({ url, keepalive: init.keepalive, ...JSON.parse(String(init.body)) }));

  it("sends nothing before it, then the kept minutes first; unticking drops the rest; ticking again is a fresh session", async () => {
    const api = window.__crumbRecord__!;
    api.buffer!(opts);
    expect(rr.starts.at(-1)?.checkoutEveryNms).toBe(MIN); // snapshots each minute while buffering
    const now = Date.now();
    rr.emit(ev(META, now - 90_000, { href: "https://app.test/billing?token=t-1" }));
    rr.emit(ev(FULL, now - 90_000));
    rr.emit(ev(INC, now - 30_000)); // the click before the customer opened the form
    listeners.pagehide!();
    await api.flush!();
    expect(sent).not.toHaveBeenCalled();
    expect(api.getSessionToken()).toBeNull();

    const a = "a".repeat(32);
    api.start({ ...opts, sessionToken: a });
    // Consent: the recorder restarts without checkouts, and the window goes first.
    expect(rr.starts.at(-1)?.checkoutEveryNms).toBeUndefined();
    rr.emit(ev(META, now, { href: "https://app.test/billing" }));
    rr.emit(ev(INC, now + 1, { blob: "x".repeat(70_000) })); // too big for keepalive
    await api.flush!();
    const [first, second] = chunks();
    expect(first).toMatchObject({ url: `https://crumb.test/api/v1/replay-sessions/${a}/chunks`, sequence: 0, keepalive: true });
    expect(first.started_at).toBe(new Date(now - 90_000).toISOString());
    expect(first.events.map((e: eventWithTime) => e.timestamp)).toEqual([now - 90_000, now - 90_000, now - 30_000]);
    expect(first.events[0].data.href).toBe("https://app.test/billing?token=[redacted]");
    expect(second).toMatchObject({ sequence: 1, keepalive: false });
    expect(api.getSessionToken()).toBe(a);

    // Unticked: stopped, and what it hadn't sent goes with it.
    rr.emit(ev(INC, now + 2));
    api.stop();
    await api.flush!();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(api.getSessionToken()).toBeNull();

    // Ticked again: a fresh session (the widget issues a new token), numbered from 0.
    const b = "b".repeat(32);
    api.start({ ...opts, sessionToken: b });
    rr.emit(ev(META, now + 3, { href: "https://app.test/billing" }));
    await api.flush!();
    expect(chunks()[2]).toMatchObject({ url: `https://crumb.test/api/v1/replay-sessions/${b}/chunks`, sequence: 0 });

    // A reload continues the tab's session, and its numbering: the server
    // refuses a number it already has.
    api.stop();
    api.start({ ...opts, sessionToken: b });
    rr.emit(ev(META, now + 4, { href: "https://app.test/billing" }));
    await api.flush!();
    expect(chunks()[3]).toMatchObject({ sequence: 1 });
  });

  it("leaves a report the recording it was sent with, so the next report gets a session of its own", () => {
    const api = window.__crumbRecord__!;
    api.stop();
    sent.mockClear();
    const c = "c".repeat(32);
    store.set("crumb_replay_token", c);
    api.start({ ...opts, sessionToken: c });
    rr.emit(ev(META, Date.now(), { href: "https://app.test/billing" }));

    // Not Maya's consented session (she said no, someone else's, another token): left alone.
    for (const consent of ["off:maya", "on:lee"]) {
      store.set("crumb_replay_consent", consent);
      expect(widget.endLinkedSession("maya", c)).toBe(false);
    }
    store.set("crumb_replay_consent", "on:maya");
    expect(widget.endLinkedSession("maya", "d".repeat(32))).toBe(false);
    expect(api.getSessionToken()).toBe(c);
    expect(sent).not.toHaveBeenCalled();

    // Her report went in with it: what the recorder held still goes to it, then
    // it stops and the token goes, so the next start is a new session. Her
    // consent stands for that one.
    expect(widget.endLinkedSession("maya", c)).toBe(true);
    expect(chunks()).toEqual([expect.objectContaining({ url: `https://crumb.test/api/v1/replay-sessions/${c}/chunks`, sequence: 0 })]);
    expect(api.getSessionToken()).toBeNull();
    expect(store.has("crumb_replay_token")).toBe(false);
    expect(store.get("crumb_replay_consent")).toBe("on:maya");
  });
});
