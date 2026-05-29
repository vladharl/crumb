// rrweb recorder shim — bundled separately from widget.js so the launcher
// renders before rrweb's full-DOM snapshot kicks in. Built via the
// `build:record` esbuild entry; exposed on `window.__crumbRecord__` and
// driven by the main widget after `/me` confirms `session_record_enabled`.

import { record, type eventWithTime } from "rrweb";

type StartOpts = {
  apiBase: string;
  workspaceSlug: string;
  sessionToken: string;
};

// Hard caps. Match the server in `lib/replay/ingest.ts` — when the server
// returns 413, the recorder also self-trips here so we stop pushing chunks
// that will just bounce back.
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EVENT_COUNT = 5000;
const MAX_DURATION_MS = 30 * 60 * 1000;  // 30 minutes

const FLUSH_EVENT_THRESHOLD = 50;
const FLUSH_MS = 5_000;

type State = {
  opts: StartOpts;
  stopRecorder: (() => void) | null;
  buffer: eventWithTime[];
  bufferBytes: number;
  sequence: number;
  startedAtMs: number;
  totalEvents: number;
  totalBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  bufferStartedAt: string | null;
  stopped: boolean;
};

let state: State | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function approximateSize(events: eventWithTime[]): number {
  // Cheap byte count without re-serializing on every emit. rrweb events
  // are JSON-shaped — characters ≈ bytes for the ASCII-heavy payloads
  // we actually ship (the few unicode strings inside are dwarfed by the
  // DOM-mutation timestamps + ids).
  let n = 2; // []
  for (const e of events) n += JSON.stringify(e).length + 1;
  return n;
}

function scheduleFlush() {
  if (!state || state.flushTimer) return;
  state.flushTimer = setTimeout(() => { void flush(); }, FLUSH_MS);
}

function clearFlushTimer() {
  if (state?.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
}

async function flush(final = false): Promise<void> {
  if (!state || state.stopped) return;
  clearFlushTimer();
  if (state.buffer.length === 0) return;

  const events = state.buffer;
  const bufferBytes = state.bufferBytes;
  const startedAt = state.bufferStartedAt ?? nowIso();
  const endedAt = nowIso();
  const sequence = state.sequence;

  state.buffer = [];
  state.bufferBytes = 0;
  state.bufferStartedAt = null;
  state.sequence += 1;
  state.totalEvents += events.length;
  state.totalBytes += bufferBytes;

  const body = JSON.stringify({
    workspace_slug: state.opts.workspaceSlug,
    sequence,
    started_at: startedAt,
    ended_at: endedAt,
    page_url: location.href,
    user_agent: navigator.userAgent,
    viewport_w: window.innerWidth,
    viewport_h: window.innerHeight,
    events,
  });

  const url = `${state.opts.apiBase}/api/v1/replay-sessions/${encodeURIComponent(state.opts.sessionToken)}/chunks`;

  if (final && typeof navigator.sendBeacon === "function") {
    // sendBeacon is the only transport that reliably survives `pagehide`.
    // It only accepts simple types; a Blob with the right content-type works
    // and keeps the request shape identical to the normal POST path.
    try {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    } catch { /* host page may CSP-block beacon; nothing we can do here */ }
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // keepalive ensures the request can complete even if the tab is closing
      // in the gap between visibilitychange and pagehide.
      keepalive: true,
    });
    if (res.status === 413 || res.status === 410 || res.status === 403) {
      // Server says we're capped, Cloud-disabled, or this workspace has the
      // feature off — stop trying so we don't burn quota or rate-limit slots.
      stop();
    }
  } catch {
    // Network blips: drop this chunk on the floor rather than retrying. v1
    // tolerates some loss; aggressive retry would amplify outages and burn
    // the per-IP rate-limit budget on the way back up.
  }
}

function emit(e: eventWithTime) {
  if (!state || state.stopped) return;
  if (state.buffer.length === 0) state.bufferStartedAt = nowIso();
  state.buffer.push(e);
  // Approximate the new bytes without re-summing the whole buffer each time.
  state.bufferBytes += JSON.stringify(e).length + 1;

  // Self-trip on caps (size, count, duration). Final flush + stop the
  // recorder so we don't keep buffering events we'll never ship.
  const elapsed = Date.now() - state.startedAtMs;
  const overSize = state.totalBytes + state.bufferBytes >= MAX_SIZE_BYTES;
  const overEvents = state.totalEvents + state.buffer.length >= MAX_EVENT_COUNT;
  const overDuration = elapsed >= MAX_DURATION_MS;
  if (overSize || overEvents || overDuration) {
    void flush().then(() => stop());
    return;
  }

  if (state.buffer.length >= FLUSH_EVENT_THRESHOLD) {
    void flush();
  } else {
    scheduleFlush();
  }
}

function start(opts: StartOpts) {
  if (state) return; // already started in this tab
  state = {
    opts,
    stopRecorder: null,
    buffer: [],
    bufferBytes: 0,
    sequence: 0,
    startedAtMs: Date.now(),
    totalEvents: 0,
    totalBytes: 0,
    flushTimer: null,
    bufferStartedAt: null,
    stopped: false,
  };

  // rrweb config:
  //   - maskAllInputs + email/password explicitly blocked: privacy default.
  //   - blockClass on shadow host + any `.crumb-block` opt-out: stops the
  //     recorder from recording its own widget UI (recursive replay).
  //   - maskTextClass `.crumb-mask`: vendor-side opt-out for text content.
  //   - sampling: trim mousemove + scroll to a tolerable cadence.
  const stopRecorder = record({
    emit,
    maskAllInputs: true,
    maskInputOptions: { password: true, email: true },
    blockClass: "crumb-block",
    blockSelector: "#crumb-widget",
    maskTextClass: "crumb-mask",
    sampling: { mousemove: 50, scroll: 100, input: "last" },
  });
  state.stopRecorder = stopRecorder ?? null;

  // Flush opportunities: tab hidden, page hide, before unload. `pagehide`
  // is the last reliable signal before navigation; we use sendBeacon there
  // because regular fetch may be canceled mid-flight on most browsers.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
  window.addEventListener("pagehide", () => { void flush(true); });
}

function stop() {
  if (!state || state.stopped) return;
  state.stopped = true;
  clearFlushTimer();
  try { state.stopRecorder?.(); } catch { /* ignore */ }
  state.stopRecorder = null;
}

function getSessionToken(): string | null {
  return state?.opts.sessionToken ?? null;
}

// Expose on window so the main widget bundle (which doesn't import rrweb)
// can drive it. Type-narrowed via `__crumbRecord__` so consumers don't have
// to deal with `unknown`.
declare global {
  interface Window {
    __crumbRecord__?: {
      start: (opts: StartOpts) => void;
      stop: () => void;
      getSessionToken: () => string | null;
    };
  }
}

window.__crumbRecord__ = { start, stop, getSessionToken };
