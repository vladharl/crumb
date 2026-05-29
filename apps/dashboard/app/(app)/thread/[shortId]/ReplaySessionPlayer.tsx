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
  onClose: () => void;
};

const SPEEDS = [1, 2, 4] as const;
type Speed = typeof SPEEDS[number];

// rrweb's `eventWithTime` minimal shape — we only need `timestamp` to
// compute the absolute base for scrubbing, and treat the rest opaquely.
type RrEvent = { timestamp: number } & Record<string, unknown>;

export function ReplaySessionPlayer({ replayId, chunks, durationMs, viewportW, viewportH, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<unknown>(null);
  const baseTimestampRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const [currentMs, setCurrentMs] = useState(0);

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

        baseTimestampRef.current = allEvents[0]?.timestamp ?? 0;

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
          mouseTail: false,
          skipInactive: false,
          showWarning: false,
        });
        replayerRef.current = replayer;
        replayer.play(0);
        setLoading(false);

        // The Replayer doesn't fire a continuous `progress` event we can
        // hook — its lifecycle is driven by an internal timer. We poll the
        // current play offset every 250ms while playing; updates pause
        // when the user pauses.
        tickRef.current = setInterval(() => {
          if (replayerRef.current) {
            const r = replayerRef.current as { getCurrentTime: () => number };
            setCurrentMs(r.getCurrentTime());
          }
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
          width: "min(1100px, 92vw)", maxHeight: "92vh",
          display: "flex", flexDirection: "column", overflow: "hidden",
          border: "var(--border)",
        }}
      >
        <div className="row gap-2 center" style={{ padding: "10px 14px", borderBottom: "var(--border)" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: "var(--fs-md)" }}>Session replay</h3>
          <span className="text-xs muted">
            {viewportW && viewportH ? `${viewportW}×${viewportH} viewport` : ""}
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" sm onClick={onClose} aria-label="Close">×</Btn>
        </div>

        <div
          ref={mountRef}
          style={{
            flex: 1, overflow: "auto", background: "var(--surface)",
            minHeight: 360,
          }}
        />

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
            <input
              type="range"
              min={0}
              max={durationMs}
              step={100}
              value={currentMs}
              onChange={e => seekTo(Number(e.target.value))}
              style={{ flex: 1 }}
              disabled={loading || !!loadErr}
              aria-label="Replay scrubber"
            />
            <span className="text-xs muted mono" style={{ minWidth: 80, textAlign: "right" }}>
              {fmtClock(currentMs)} / {fmtClock(durationMs)}
            </span>
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
