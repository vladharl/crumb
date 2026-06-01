"use client";

import { useEffect, useRef, useState } from "react";
import { Btn } from "@crumb/ui";

type ChunkMeta = {
  sequence: number;
  sizeBytes: number;
  eventCount: number;
  startedAt: string;
  endedAt: string;
};

type Props = {
  replayId: string;
  chunks: ChunkMeta[];
  durationMs: number;
  viewportW: number | null;
  viewportH: number | null;
  details?: ReplayDetails | null;
  onClose: () => void;
};

const SPEEDS = [1, 2, 4] as const;
type Speed = typeof SPEEDS[number];

// rrweb's `eventWithTime` minimal shape — we only need `timestamp` to
// compute the absolute base for scrubbing, and treat the rest opaquely.
type RrEvent = { timestamp: number } & Record<string, unknown>;

// Network request the recorder captured as an rrweb custom event (type 5,
// tag "network"). `t` is ms from session start (for click-to-seek).
type NetEvent = {
  t: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  reqBody?: string;
  respBody?: string;
  reqBytes?: number;
  respBytes?: number;
  error?: string;
};

function statusColor(s: number): string {
  if (s === 0 || s >= 500) return "var(--danger, #c0392b)";
  if (s >= 400) return "var(--warn, #d4a24c)";
  if (s >= 300) return "var(--mute-2, #8a8278)";
  return "var(--ok, #6b8e5a)";
}

// Session context shown in the player header (and a compact line on the card).
export type ReplayDetails = {
  deviceType: string | null;
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  screenW: number | null;
  screenH: number | null;
  callerIp: string | null;
  geoCountry: string | null;
  geoCity: string | null;
};

function detailsSummary(d: ReplayDetails | null | undefined, vw: number | null, vh: number | null): string {
  const parts: string[] = [];
  if (d?.browserName) parts.push(d.browserVersion ? `${d.browserName} ${d.browserVersion.split(".")[0]}` : d.browserName);
  if (d?.osName) parts.push(d.osVersion ? `${d.osName} ${d.osVersion}` : d.osName);
  if (d?.deviceType) parts.push(d.deviceType.charAt(0).toUpperCase() + d.deviceType.slice(1));
  const loc = [d?.geoCity, d?.geoCountry].filter(Boolean).join(", ") || d?.callerIp || "";
  if (loc) parts.push(loc);
  if (vw && vh) parts.push(`${vw}×${vh}`);
  return parts.join("  ·  ");
}

// Idle detection: a wall-clock gap with NO events at all means the user did
// nothing (rrweb emits continuously while anything moves/mutates). We keep a
// short lead-in after the last activity, then skip the rest of the gap.
const IDLE_GAP_MS = 3000;
const KEEP_LEAD_MS = 800;
type IdleRange = { start: number; end: number };

// Spans of the timeline (ms from session start) with no activity worth watching.
function computeIdleRanges(events: RrEvent[], base: number): IdleRange[] {
  const ranges: IdleRange[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!.timestamp - base;
    const cur = events[i]!.timestamp - base;
    if (cur - prev > IDLE_GAP_MS) {
      const start = prev + KEEP_LEAD_MS;
      const end = cur - 200;
      if (end - start > 300) ranges.push({ start, end });
    }
  }
  return ranges;
}

// rrweb's Replayer draws a `.replayer-mouse` cursor + click ripple, but only
// if its stylesheet is present — which we don't bundle. Inject the handful of
// rules (cursor arrow, click pulse, movement tail) once so the pointer and
// clicks are actually visible during playback.
const REPLAY_STYLE_ID = "crumb-rrweb-replay-style";
function injectReplayStyles() {
  if (typeof document === "undefined" || document.getElementById(REPLAY_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = REPLAY_STYLE_ID;
  el.textContent = `
.replayer-wrapper { position: relative; }
.replayer-mouse {
  position: absolute; width: 20px; height: 20px; transition: left .05s linear, top .05s linear;
  background-repeat: no-repeat; background-size: contain; background-position: center;
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M3 2 L3 16 L7 12 L10 18 L12.5 17 L9.5 11 L15 11 Z" fill="black" stroke="white" stroke-width="1"/></svg>');
  z-index: 2147483646; pointer-events: none;
}
.replayer-mouse::after {
  content: ""; display: inline-block; width: 20px; height: 20px; border-radius: 50%;
  background: rgb(73,80,246); transform: translate(-50%,-50%); opacity: 0;
}
.replayer-mouse.active::after { animation: crumb-mouse-pulse .35s ease-out; }
@keyframes crumb-mouse-pulse {
  0% { opacity: .45; transform: translate(-50%,-50%) scale(.35); }
  100% { opacity: 0; transform: translate(-50%,-50%) scale(1.6); }
}
.replayer-mouse-tail { position: absolute; pointer-events: none; z-index: 2147483645; }
`;
  document.head.appendChild(el);
}

export function ReplaySessionPlayer({ replayId, chunks, durationMs, viewportW, viewportH, details, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<unknown>(null);
  const baseTimestampRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const [currentMs, setCurrentMs] = useState(0);
  const [skipIdle, setSkipIdle] = useState(true);
  const [idleRanges, setIdleRanges] = useState<IdleRange[]>([]);
  const [netEvents, setNetEvents] = useState<NetEvent[]>([]);
  const [openRow, setOpenRow] = useState<number | null>(null);

  // Refs so the 250ms tick reads live values without re-subscribing.
  const idleRangesRef = useRef<IdleRange[]>([]);
  const skipIdleRef = useRef(true);
  const playingRef = useRef(true);
  useEffect(() => { skipIdleRef.current = skipIdle; }, [skipIdle]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Pull all chunks in parallel. rrweb's Replayer needs the full
        // event array up front; streaming-as-you-play is an rrweb-side
        // feature we'd have to wire ourselves and isn't worth it for
        // sessions capped at 10 MB / 5000 events.
        const responses = await Promise.all(
          chunks.map(c => fetch(`/api/v1/replay-sessions/${replayId}/chunks/${c.sequence}`)),
        );
        for (const r of responses) {
          if (!r.ok) throw new Error(`chunk ${r.url} failed (${r.status})`);
        }
        const arrays = await Promise.all(responses.map(r => r.json() as Promise<RrEvent[]>));
        const allEvents: RrEvent[] = arrays.flat();
        if (allEvents.length === 0) throw new Error("no events");

        // Lazy-import rrweb on open so the main thread isn't taxed by it
        // until the vendor actually clicks "Watch replay".
        const rrweb = await import("rrweb");

        if (cancelled || !mountRef.current) return;

        // Clear previous mount on speed change / re-init.
        mountRef.current.innerHTML = "";
        injectReplayStyles();

        baseTimestampRef.current = allEvents[0]?.timestamp ?? 0;

        // Precompute idle spans for auto-skip + scrubber shading.
        const ranges = computeIdleRanges(allEvents, baseTimestampRef.current);
        idleRangesRef.current = ranges;
        setIdleRanges(ranges);

        // Extract captured network calls (rrweb custom events, tag "network").
        const base = baseTimestampRef.current;
        const nets: NetEvent[] = allEvents
          .filter(e => (e as { type?: number }).type === 5 && (e as { data?: { tag?: string } }).data?.tag === "network")
          .map(e => {
            const payload = (e as unknown as { data: { payload: Omit<NetEvent, "t"> } }).data.payload;
            return { ...payload, t: Math.max(0, e.timestamp - base) };
          });
        setNetEvents(nets);

        // rrweb's Replayer constructor wants `eventWithTime[]`; we keep
        // the wire shape opaque (`RrEvent`) so we don't have to copy
        // every type its plugin system references. The runtime cares
        // about `timestamp` + `type` + `data` which the server-provided
        // events already carry.
        const replayer = new rrweb.Replayer(allEvents as unknown as import("rrweb").eventWithTime[], {
          root: mountRef.current,
          // We render the recorded page at its captured viewport so
          // layouts read identically. The mount container itself scrolls
          // if the viewport exceeds the modal width.
          UNSAFE_replayCanvas: false,
          // Show the recorded cursor + a movement tail so the vendor can
          // follow exactly where the customer pointed and clicked.
          mouseTail: true,
          // The low-level Replayer ignores skipInactive; we implement idle
          // skipping ourselves in the tick below.
          skipInactive: false,
          showWarning: false,
        });
        replayerRef.current = replayer;
        replayer.play(0);
        setLoading(false);

        // The Replayer doesn't fire a continuous `progress` event we can
        // hook — its lifecycle is driven by an internal timer. We poll the
        // current play offset every 250ms while playing; updates pause
        // when the user pauses. This is also where we fast-forward idle gaps.
        tickRef.current = setInterval(() => {
          const r = replayerRef.current as { getCurrentTime: () => number; play: (t?: number) => void } | null;
          if (!r) return;
          let t = r.getCurrentTime();
          if (skipIdleRef.current && playingRef.current) {
            const gap = idleRangesRef.current.find(rg => t >= rg.start && t < rg.end - 50);
            if (gap) { r.play(gap.end); t = gap.end; }
          }
          setCurrentMs(t);
        }, 250);
      } catch (err) {
        if (cancelled) return;
        setLoadErr(err instanceof Error ? err.message : "Could not load replay");
        setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (tickRef.current) clearInterval(tickRef.current);
      const r = replayerRef.current as { pause?: () => void; destroy?: () => void } | null;
      try { r?.pause?.(); } catch { /* ignore */ }
      try { r?.destroy?.(); } catch { /* ignore */ }
      replayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayId]);

  function togglePlay() {
    const r = replayerRef.current as { play: (t?: number) => void; pause: () => void } | null;
    if (!r) return;
    if (playing) { r.pause(); setPlaying(false); }
    else { r.play(currentMs); setPlaying(true); }
  }

  function setPlaybackSpeed(s: Speed) {
    const r = replayerRef.current as { setConfig: (c: { speed: number }) => void } | null;
    if (!r) return;
    r.setConfig({ speed: s });
    setSpeed(s);
  }

  function seekTo(ms: number) {
    const r = replayerRef.current as { play: (t?: number) => void; pause: () => void } | null;
    if (!r) return;
    const clamped = Math.max(0, Math.min(ms, durationMs));
    if (playing) r.play(clamped); else r.pause();
    setCurrentMs(clamped);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg)", borderRadius: "var(--r-md)",
          width: netEvents.length ? "min(1320px, 94vw)" : "min(1100px, 92vw)", maxHeight: "92vh",
          display: "flex", flexDirection: "column", overflow: "hidden",
          border: "var(--border)",
        }}
      >
        <div className="row gap-2 center" style={{ padding: "10px 14px", borderBottom: "var(--border)" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: "var(--fs-md)" }}>Session replay</h3>
          <span className="text-xs muted">{detailsSummary(details, viewportW, viewportH)}</span>
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" sm onClick={onClose} aria-label="Close">×</Btn>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 360, overflow: "hidden" }}>
          <div
            ref={mountRef}
            style={{ flex: 1, overflow: "auto", background: "var(--surface)" }}
          />
          {netEvents.length > 0 && (
            <div style={{ width: 340, borderLeft: "var(--border)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div className="row gap-2 center" style={{ padding: "8px 12px", borderBottom: "var(--border)" }}>
                <span className="text-xs" style={{ fontWeight: 600 }}>Network</span>
                <span className="text-2xs muted">{netEvents.length} request{netEvents.length === 1 ? "" : "s"}</span>
              </div>
              <div style={{ flex: 1, overflow: "auto" }}>
                {netEvents.map((n, i) => (
                  <div key={i} style={{ borderBottom: "var(--border)", padding: "6px 12px" }}>
                    <div
                      className="row gap-2 center"
                      style={{ cursor: "pointer" }}
                      onClick={() => { setOpenRow(openRow === i ? null : i); seekTo(n.t); }}
                      title={`Jump to ${fmtClock(n.t)}`}
                    >
                      <span className="mono text-2xs" style={{ color: statusColor(n.status), minWidth: 26, fontWeight: 600 }}>{n.status || "ERR"}</span>
                      <span className="mono text-2xs muted" style={{ minWidth: 30 }}>{n.method}</span>
                      <span className="text-2xs truncate" style={{ flex: 1 }} title={n.url}>{shortUrl(n.url)}</span>
                      <span className="text-2xs muted mono">{Math.round(n.durationMs)}ms</span>
                    </div>
                    {openRow === i && (
                      <div className="col gap-1" style={{ marginTop: 6 }}>
                        <span className="text-2xs muted mono" style={{ wordBreak: "break-all" }}>{n.url}</span>
                        {n.error && <span className="text-2xs" style={{ color: "var(--danger)" }}>{n.error}</span>}
                        {n.reqBody && <NetBody label="Request" body={n.reqBody} />}
                        {n.respBody && <NetBody label="Response" body={n.respBody} />}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {loading && (
          <div className="row center" style={{ padding: 14, color: "var(--mute-2)" }}>
            Loading replay…
          </div>
        )}
        {loadErr && (
          <div className="row center" style={{ padding: 14, color: "var(--danger)" }}>
            {loadErr}
          </div>
        )}

        <div className="col gap-2" style={{ padding: "10px 14px", borderTop: "var(--border)" }}>
          {/* Best-effort caveat — captured fonts/CSS from third-party CDNs
              without CORS can't be inlined by rrweb, so replays sometimes
              render with fallback styles. Cheaper to disclose than to fix. */}
          <span className="text-2xs muted">
            Replay is best-effort. Fonts or styles served from third-party CDNs without CORS may differ.
          </span>
          <div className="row gap-2 center">
            <Btn variant="ghost" sm onClick={togglePlay} disabled={loading || !!loadErr}>
              {playing ? "Pause" : "Play"}
            </Btn>
            {/* Scrubber with a thin strip above it shading the idle spans that
                get auto-skipped when "Skip idle" is on. */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ position: "relative", height: 3 }}>
                {durationMs > 0 && idleRanges.map((rg, i) => (
                  <div
                    key={i}
                    title="Inactive, auto-skipped"
                    style={{
                      position: "absolute", top: 0, height: 3, borderRadius: 2,
                      left: `${(rg.start / durationMs) * 100}%`,
                      width: `${Math.max(0.4, ((rg.end - rg.start) / durationMs) * 100)}%`,
                      background: "var(--warn, #d4a24c)", opacity: 0.6,
                    }}
                  />
                ))}
              </div>
              <input
                type="range"
                min={0}
                max={durationMs}
                step={100}
                value={currentMs}
                onChange={e => seekTo(Number(e.target.value))}
                style={{ width: "100%" }}
                disabled={loading || !!loadErr}
                aria-label="Replay scrubber"
              />
            </div>
            <span className="text-xs muted mono" style={{ minWidth: 80, textAlign: "right" }}>
              {fmtClock(currentMs)} / {fmtClock(durationMs)}
            </span>
            <Btn
              variant={skipIdle ? "primary" : "ghost"}
              sm
              onClick={() => setSkipIdle(v => !v)}
              disabled={loading || !!loadErr}
              title="Fast-forward gaps with no activity"
            >
              Skip idle
            </Btn>
            <div className="row gap-1">
              {SPEEDS.map(s => (
                <Btn
                  key={s}
                  variant={speed === s ? "primary" : "ghost"}
                  sm
                  onClick={() => setPlaybackSpeed(s)}
                  disabled={loading || !!loadErr}
                >
                  {s}×
                </Btn>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

// Show just the path + query so the network list stays readable.
function shortUrl(u: string): string {
  try { const x = new URL(u); return (x.pathname + x.search) || x.href; } catch { return u; }
}

function NetBody({ label, body }: { label: string; body: string }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="text-2xs muted" style={{ fontWeight: 600 }}>{label}</span>
      <pre
        className="text-2xs mono"
        style={{
          margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
          maxHeight: 140, overflow: "auto", background: "var(--surface)",
          padding: 6, borderRadius: 4,
        }}
      >{body}</pre>
    </div>
  );
}
