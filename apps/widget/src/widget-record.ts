// rrweb recorder shim — bundled separately from widget.js so the launcher
// renders before rrweb's full-DOM snapshot kicks in. Built via the
// `build:record` esbuild entry; exposed on `window.__crumbRecord__` and
// driven by the main widget after `/me` confirms `session_record_enabled`.

import { record, EventType, type eventWithTime } from "rrweb";
import { isSecretKey, redactPairs, redactUrl } from "./redact";

type StartOpts = {
  apiBase: string;
  workspaceSlug: string;
  sessionToken: string;
  /** Host opted in with data-record-network-bodies="true" on the widget
   *  script tag. Off by default: requests record without bodies. */
  captureBodies?: boolean;
};

// Hard caps. Match the server in `lib/replay/ingest.ts` — when the server
// returns 413, the recorder also self-trips here so we stop pushing chunks
// that will just bounce back.
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EVENT_COUNT = 5000;
const MAX_DURATION_MS = 30 * 60 * 1000;  // 30 minutes

const FLUSH_EVENT_THRESHOLD = 50;
const FLUSH_MS = 5_000;

// Network capture: cap per-body size + total count so the network stream can't
// blow past the per-session byte/event caps on its own.
const MAX_NET_BODY = 2048;
const MAX_NET_EVENTS = 200;

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
  netCount: number;
  restoreNetwork: (() => void) | null;
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
    // The page URL can carry a reset ?token= or an OAuth #access_token, and it
    // lands in the manifest and the AI summary: same redaction as requests.
    page_url: redactUrl(location.href),
    user_agent: navigator.userAgent,
    viewport_w: window.innerWidth,
    viewport_h: window.innerHeight,
    screen_w: screen.width,
    screen_h: screen.height,
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
  // rrweb's Meta event records the page URL too (see page_url in flush).
  if (e.type === EventType.Meta) e.data.href = redactUrl(e.data.href);
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

// ─── network capture ─────────────────────────────────────
// Patches fetch + XHR to record one rrweb custom event per request. Events
// ride the same rrweb stream via addCustomEvent, so they chunk/store/align on
// the timeline for free. The player extracts them by `data.tag === "network"`.
//
// Privacy: a request records as method, URL (secret-looking query values
// redacted), status and timing. Bodies are recorded only when the host opts in
// (StartOpts.captureBodies), and even then secret-looking form, query and JSON
// values are redacted. Headers and cookies are never recorded. toNetEvent is the
// one place that policy lives; both wrappers route through it.

type NetEvent = {
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

// What a wrapper saw, before the policy is applied.
type RawNet = {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  error?: string;
  reqBody?: unknown;  // whatever was handed to fetch / XHR.send
  respText?: string;  // only read when bodies are on
};

function clip(s: string): string {
  return s.length > MAX_NET_BODY ? s.slice(0, MAX_NET_BODY) + "…[truncated]" : s;
}

// Secret-named values (query string, form body, JSON key) go by the names in
// ./redact, the same ones the widget's page URLs and the server use. With
// bodies on, a secret under an innocent name still records.

// Parsed JSON: secret-keyed values go, strings get the pair pass (a presigned
// URL inside a response, say).
function scrub(v: unknown, key = ""): unknown {
  if (isSecretKey(key)) return "[redacted]";
  if (typeof v === "string") return redactPairs(v);
  if (Array.isArray(v)) return v.map(x => scrub(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = scrub((v as Record<string, unknown>)[k], k);
    return out;
  }
  return v;
}

// "key": value pairs in text that isn't one JSON document (NDJSON, JSONP).
const JSON_PAIR = /("([^"\\]*)"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/g;

export function redactBody(s: string): string {
  try { return JSON.stringify(scrub(JSON.parse(s))); } catch { /* not a JSON document */ }
  return redactPairs(s.replace(JSON_PAIR, (m, head: string, k: string) => (isSecretKey(k) ? `${head}"[redacted]"` : m)));
}

function bodyToText(body: unknown): { text?: string; bytes?: number } {
  if (body == null) return {};
  if (typeof body === "string" || body instanceof URLSearchParams) {
    const s = String(body);
    return { text: clip(redactBody(s)), bytes: s.length };
  }
  const name = (body as { constructor?: { name?: string } })?.constructor?.name;
  return { text: `[${name ?? "binary"}]` };
}

// What one captured request becomes on the recording.
export function toNetEvent(r: RawNet, withBodies: boolean): NetEvent {
  const ev: NetEvent = { method: r.method, url: redactUrl(r.url), status: r.status, durationMs: r.durationMs };
  if (r.error) ev.error = r.error;
  if (!withBodies) return ev;
  const req = bodyToText(r.reqBody);
  if (req.text !== undefined) { ev.reqBody = req.text; ev.reqBytes = req.bytes; }
  if (r.respText !== undefined) { ev.respBody = clip(redactBody(r.respText)); ev.respBytes = r.respText.length; }
  return ev;
}

function isTextContentType(ct: string): boolean {
  return /json|text|xml|form-urlencoded|javascript/i.test(ct);
}

const bodiesOn = (): boolean => state?.opts.captureBodies === true;

function recordNet(r: RawNet): void {
  if (!state || state.stopped) return;
  if (state.netCount >= MAX_NET_EVENTS) return;
  state.netCount += 1;
  try { record.addCustomEvent("network", toNetEvent(r, bodiesOn())); } catch { /* recorder gone */ }
}

type XhrMeta = { method: string; url: string; started: number; body?: unknown };
interface XhrWithMeta extends XMLHttpRequest { __crumbNet?: XhrMeta }

function patchNetwork(apiBase: string): () => void {
  const skip = (u: string): boolean => !u || u.startsWith(apiBase) || /^(data|blob):/i.test(u);

  const origFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args;
    let url = ""; let method = "GET";
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // `||` (not `??`) so an empty/absent method falls through to GET.
      method = (init?.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : "") || "GET").toUpperCase();
    } catch { /* leave defaults */ }
    if (skip(url)) return origFetch.apply(this, args);
    const started = Date.now();
    const reqBody = init?.body;
    return origFetch.apply(this, args).then(
      (res) => {
        const r: RawNet = { method, url, status: res.status, durationMs: Date.now() - started, reqBody };
        // Response text only when the host opted into bodies; read from a
        // clone in the background so we never delay the caller's response.
        if (bodiesOn() && isTextContentType(res.headers.get("content-type") ?? "")) {
          res.clone().text().then(t => recordNet({ ...r, respText: t }), () => recordNet(r));
        } else {
          recordNet(r);
        }
        return res;
      },
      (err: unknown) => {
        recordNet({ method, url, status: 0, durationMs: Date.now() - started, reqBody, error: err instanceof Error ? err.message : String(err) });
        throw err;
      },
    );
  };

  // Cast the assignments: XHR.open/send are overloaded, and a wrapper can't
  // structurally satisfy both overloads — so we type the wrapper loosely and
  // assert it back to the prototype's type.
  const origOpen = XMLHttpRequest.prototype.open as (...a: unknown[]) => void;
  const origSend = XMLHttpRequest.prototype.send as (...a: unknown[]) => void;
  XMLHttpRequest.prototype.open = function (this: XhrWithMeta, ...args: unknown[]) {
    const url = args[1];
    this.__crumbNet = {
      method: String(args[0] ?? "GET").toUpperCase(),
      url: typeof url === "string" ? url : url instanceof URL ? url.href : String(url),
      started: 0,
    };
    return origOpen.apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XhrWithMeta, ...args: unknown[]) {
    const meta = this.__crumbNet;
    if (meta && !skip(meta.url)) {
      meta.started = Date.now();
      meta.body = args[0];
      this.addEventListener("loadend", () => {
        let respText: string | undefined;
        if (bodiesOn()) {
          try {
            const ct = this.getResponseHeader("content-type") ?? "";
            if ((this.responseType === "" || this.responseType === "text") && isTextContentType(ct)) {
              respText = String(this.responseText ?? "");
            }
          } catch { /* cross-origin response text may throw */ }
        }
        recordNet({ method: meta.method, url: meta.url, status: this.status, durationMs: Date.now() - meta.started, reqBody: meta.body, respText });
      });
    }
    return origSend.apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;

  return () => {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = origSend as typeof XMLHttpRequest.prototype.send;
  };
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
    netCount: 0,
    restoreNetwork: null,
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

  // Capture network calls (excluding our own chunk POSTs to apiBase).
  try { state.restoreNetwork = patchNetwork(opts.apiBase); } catch { state.restoreNetwork = null; }

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
  try { state.restoreNetwork?.(); } catch { /* ignore */ }
  state.restoreNetwork = null;
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
