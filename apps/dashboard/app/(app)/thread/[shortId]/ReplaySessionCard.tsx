"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Card, CardHead, Ic, Pill } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { ReplaySessionPlayer } from "./ReplaySessionPlayer";

export type ReplayCardData = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  pageUrl: string | null;
  userAgent: string | null;
  viewportW: number | null;
  viewportH: number | null;
  screenW: number | null;
  screenH: number | null;
  deviceType: string | null;
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  callerIp: string | null;
  geoCountry: string | null;
  geoCity: string | null;
  eventCount: number;
  sizeBytes: number;
  durationMs: number;
  chunks: Array<{ sequence: number; sizeBytes: number; eventCount: number; startedAt: string; endedAt: string }>;
  // AI summary (feature 8)
  summary: string | null;
  highlights: string[] | null;
  aiSummaryAvailable: boolean;
};

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}m ${rem}s`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Inline play glyph — Ic doesn't carry a media icon and a one-off SVG is
// lighter than extending the shared icon set for a single use site.
function PlayGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 3l9 5-9 5z" fill="currentColor" />
    </svg>
  );
}

export function ReplaySessionCard({ replay }: { replay: ReplayCardData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [summaryError, setSummaryError] = useState<string | null>(null);

  function summarize() {
    setSummaryError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/v1/replay-sessions/${replay.id}/summary`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setSummaryError(data?.error === "ai_cap_reached" ? errorMessage("ai_cap_reached") : data?.error === "no_events" ? "Not enough recorded activity to summarize." : "Couldn't summarize this session.");
          return;
        }
        router.refresh();
      } catch {
        setSummaryError("Couldn't summarize this session.");
      }
    });
  }

  // Strip query/hash so the displayed URL is the page the customer was on,
  // not their session bookkeeping.
  let displayUrl = replay.pageUrl ?? "";
  try {
    if (replay.pageUrl) {
      const u = new URL(replay.pageUrl);
      displayUrl = `${u.host}${u.pathname}`;
    }
  } catch { /* leave as-is */ }

  // Compact device + location line (e.g. "Chrome · macOS · US").
  const deviceLine = [
    replay.browserName,
    replay.osName,
    [replay.geoCity, replay.geoCountry].filter(Boolean).join(", ") || null,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <Card>
        <CardHead title="Session replay" />
        <div className="card-body col gap-3">
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            <Pill solid>{fmtDuration(replay.durationMs)}</Pill>
            <span className="text-xs muted">{replay.eventCount.toLocaleString()} events</span>
            <span className="text-xs muted mono">{fmtBytes(replay.sizeBytes)}</span>
          </div>
          {displayUrl && (
            <div className="text-xs muted truncate" title={replay.pageUrl ?? undefined}>
              on {displayUrl}
            </div>
          )}
          {deviceLine && (
            <div className="text-xs muted truncate" title={replay.userAgent ?? undefined}>
              {deviceLine}
            </div>
          )}

          {replay.summary ? (
            <div className="col gap-2" style={{
              padding: 10, border: "var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface-2)",
            }}>
              <span className="eyebrow row gap-1 center"><Ic.sparkle style={{ width: 11, height: 11 }} /> AI summary</span>
              <p className="text-sm" style={{ margin: 0, lineHeight: 1.55 }}>{replay.summary}</p>
              {replay.highlights && replay.highlights.length > 0 && (
                <ul className="text-xs muted" style={{ margin: "2px 0 0", paddingLeft: 16, lineHeight: 1.6 }}>
                  {replay.highlights.map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              )}
              {replay.aiSummaryAvailable && (
                <button
                  type="button"
                  onClick={summarize}
                  disabled={pending}
                  className="text-2xs muted"
                  style={{ alignSelf: "flex-start", background: "none", border: 0, cursor: "pointer", padding: "5px 0", margin: "-5px 0", textDecoration: "underline" }}
                >
                  {pending ? "Regenerating…" : "Regenerate"}
                </button>
              )}
            </div>
          ) : replay.aiSummaryAvailable ? (
            <Btn sm variant="ghost" icon={<Ic.sparkle style={{ width: 12, height: 12 }} />} onClick={summarize} disabled={pending || replay.chunks.length === 0}>
              {pending ? "Summarizing…" : "Summarize session"}
            </Btn>
          ) : null}
          {summaryError && <span className="text-xs" style={{ color: "var(--err-text)" }}>{summaryError}</span>}

          <Btn variant="primary" onClick={() => setOpen(true)} disabled={replay.chunks.length === 0}>
            <PlayGlyph />
            <span style={{ marginLeft: 6 }}>Watch replay</span>
          </Btn>
        </div>
      </Card>
      {open && (
        <ReplaySessionPlayer
          replayId={replay.id}
          chunks={replay.chunks}
          durationMs={replay.durationMs}
          viewportW={replay.viewportW}
          viewportH={replay.viewportH}
          details={{
            deviceType: replay.deviceType,
            browserName: replay.browserName,
            browserVersion: replay.browserVersion,
            osName: replay.osName,
            osVersion: replay.osVersion,
            screenW: replay.screenW,
            screenH: replay.screenH,
            callerIp: replay.callerIp,
            geoCountry: replay.geoCountry,
            geoCity: replay.geoCity,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
