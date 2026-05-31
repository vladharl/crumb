"use client";

import { useState } from "react";
import { Btn, Card, CardHead, Pill } from "@crumb/ui";
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
  const [open, setOpen] = useState(false);

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
