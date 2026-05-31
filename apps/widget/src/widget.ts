// Crumb embed widget — vanilla TS, shadow DOM, no framework.
// Loaded via:
//   <script src="https://your-crumb-host/widget.js"
//           data-workspace="southbeam"
//           data-user-email="maya@acme.co"
//           data-user-name="Maya"
//           data-account-name="Acme Co"
//           defer></script>

import { animate, type AnimationPlaybackControls } from "motion";
import { css } from "./styles";

// We use Motion for the SVG-root rotation (single-element animations
// compose cleanly) and native WAAPI element.animate() for the per-circle
// opacity wave. Motion's array form silently no-ops on SVGCircleElement
// collections inside a shadow root, but raw element.animate() works.

// Spring shape for the settle. Approximates stiffness:220/damping:18 with a
// cubic-bezier overshoot — keeps us off the full spring physics module.
const SPRING_OVERSHOOT_EASE: [number, number, number, number] = [0.34, 1.56, 0.64, 1];

type ItemType = "bug" | "idea" | "question";

type Status =
  | "open" | "review" | "planned" | "progress"
  | "shipped" | "declined" | "deferred" | "duplicate";

type Config = {
  workspace: string;
  /** Optional identity JWT. When present, sent as Authorization: Bearer
   *  and the API trusts only its claims. Without it, the widget falls back
   *  to data-user-email — fine for the OSS demo, weak for production. */
  jwt?: string;
  userEmail: string;
  userName?: string;
  accountName: string;
  apiBase: string;
};

type ItemSummary = {
  short_id: string;
  title: string;
  type: ItemType;
  status: Status;
  created_at: string;
  updated_at: string;
  reply_count: number;
};

type ThreadAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
};

type ThreadMessage = {
  id: string;
  kind: "vendor" | "customer";
  author_name: string;
  author_initials: string;
  body: string;
  created_at: string;
  attachments?: ThreadAttachment[];
};

type StatusEvent = {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  at: string;
  by_name: string | null;
};

type ThreadData = {
  item: ItemSummary;
  workspace: { name: string };
  messages: ThreadMessage[];
  events: StatusEvent[];
};

type View =
  | { kind: "list" }
  | { kind: "admin" }
  | { kind: "roadmap" }
  | { kind: "settings" }
  | { kind: "compose"; type: ItemType; title: string; body: string }
  | { kind: "thread"; shortId: string; reply: string }
  | { kind: "confirm"; shortId: string };

type RoadmapEntry = { id: string; short_id: string; name: string; description: string | null; status: string; following: boolean };
type RoadmapData = { columns: { now: RoadmapEntry[]; next: RoadmapEntry[]; later: RoadmapEntry[] } };

type NotifPrefs = { replies: boolean; status: boolean; roadmap: boolean; unsubscribed_all: boolean };
type Me = {
  user: { id: string; name: string; email: string; initials: string; role: string };
  workspace: { slug: string; name: string; accent?: string; launcher_bg?: string; launcher_glass?: boolean; position?: string; session_record_enabled?: boolean };
  account: { id: string; name: string; member_count: number };
  is_account_admin: boolean;
  has_roadmap?: boolean;
  // Only true when the deployment can actually send email — gates the
  // Notifications view (no point offering prefs we can't deliver).
  email_enabled?: boolean;
  notifications?: NotifPrefs;
  members: Array<{ id: string; name: string; email: string; initials: string; role: string; item_count: number }>;
};

type AsyncState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

// ─── config ────────────────────────────────────────────────
function readConfig(): Config | null {
  const script = (document.currentScript as HTMLScriptElement | null)
    ?? Array.from(document.scripts).reverse().find(s => s.src.includes("widget.js"))
    ?? null;
  if (!script) return null;
  const d = (k: string) => script.dataset[k] ?? "";

  const workspace = d("workspace");
  const jwt = d("userJwt") || undefined;
  const userEmail = d("userEmail");
  const accountName = d("accountName");
  const missing: string[] = [];
  if (!workspace) missing.push("data-workspace");
  if (!jwt) {
    if (!userEmail)   missing.push("data-user-email");
    if (!accountName) missing.push("data-account-name");
  }
  if (missing.length) {
    console.warn(
      `[crumb] widget did not mount — missing required attribute${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
      `See your Crumb dashboard's Settings → Install for the full embed snippet.`,
    );
    return null;
  }

  const explicitApi = d("api");
  const apiBase = explicitApi || new URL(script.src, location.href).origin || location.origin;

  return {
    workspace,
    jwt,
    userEmail: userEmail || "",
    userName: d("userName") || undefined,
    accountName: accountName || "",
    apiBase,
  };
}

// ─── brand mark ────────────────────────────────────────────
// The Loop: five dots curving into a comma. Same composition as the
// dashboard's `BrandMark` so the brand reads identically across the product.
// viewBox is padded ( -5 to 37 in both axes ) so the outermost dots have
// ~4px of breathing room and never get clipped by the SVG bounds. Dot
// coordinates themselves stay on the same 32-unit grid as the rest of
// the brand so the composition reads the same as the dashboard mark.
const LOOP_LAUNCHER = `<svg viewBox="-5 -5 42 42" aria-hidden="true">
  <circle cx="16" cy="3"  r="2.6" opacity="0.30"/>
  <circle cx="28" cy="11" r="3.1" opacity="0.46"/>
  <circle cx="28" cy="22" r="3.6" opacity="0.62"/>
  <circle cx="17" cy="29" r="4.1" opacity="0.80"/>
  <circle cx="4"  cy="22" r="4.6" opacity="0.95"/>
</svg>`;

const LOOP_HEAD = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="5"  r="2.0" opacity="0.45"/>
  <circle cx="26" cy="11" r="2.4" opacity="0.60"/>
  <circle cx="27" cy="22" r="2.8" opacity="0.75"/>
  <circle cx="18" cy="28" r="3.2" opacity="0.88"/>
  <circle cx="7"  cy="22" r="3.6"/>
</svg>`;

// ─── icons ─────────────────────────────────────────────────
const ICONS = {
  bug:      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="6" height="8" rx="3"/><path d="M3 6l2 1M3 10h2M3 13l2-1M13 6l-2 1M13 10h-2M13 13l-2-1M6 4l1-2h2l1 2"/></svg>`,
  idea:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5A4.5 4.5 0 0 0 3.5 6c0 2 1 3 2 4v1h5V10c1-1 2-2 2-4A4.5 4.5 0 0 0 8 1.5zM6 13.5h4M6.5 15h3"/></svg>`,
  question: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M6 6.5a2 2 0 1 1 3 1.5L8 9.5M8 11.5v.01"/></svg>`,
  chat:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 11.5a1.5 1.5 0 0 1-1.5 1.5H6l-3 2.5V13H3.5A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5z"/></svg>`,
  send:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8l12-6-4 13-3-6z"/></svg>`,
  x:        `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l10 10M13 3L3 13"/></svg>`,
  check:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3 7-7"/></svg>`,
  plus:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>`,
  back:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4l-4 4 4 4"/></svg>`,
  expand:   `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3l-5 5M7 13H3v-4M3 13l5-5"/></svg>`,
  collapse: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7H9V3M9 7l4-4M3 9h4v4M7 9l-4 4"/></svg>`,
  attach:   `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7L7.5 12.5a3 3 0 0 1-4.24-4.24L9 2.5a2 2 0 0 1 2.83 2.83L6 10.78"/></svg>`,
  gear:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.4v1.7M8 12.9v1.7M14.6 8h-1.7M3.1 8H1.4M12.66 3.34l-1.2 1.2M4.54 11.46l-1.2 1.2M12.66 12.66l-1.2-1.2M4.54 4.54l-1.2-1.2"/></svg>`,
  trash:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8"/></svg>`,
};

const TYPES: Array<{ key: ItemType; label: string; icon: string }> = [
  { key: "bug",      label: "Bug",      icon: ICONS.bug },
  { key: "idea",     label: "Idea",     icon: ICONS.idea },
  { key: "question", label: "Question", icon: ICONS.question },
];

const STATUS_LABEL: Record<Status, string> = {
  open:      "Open",
  review:    "In review",
  planned:   "Planned",
  progress:  "In progress",
  shipped:   "Shipped",
  declined:  "Won’t ship",
  deferred:  "Set aside",
  duplicate: "Duplicate",
};

// ─── time helper ──────────────────────────────────────────
function ageFrom(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "just now";
  const units: Array<[string, number]> = [
    ["w", 1000 * 60 * 60 * 24 * 7],
    ["d", 1000 * 60 * 60 * 24],
    ["h", 1000 * 60 * 60],
    ["m", 1000 * 60],
  ];
  for (const [u, ms] of units) if (d >= ms) return `${Math.floor(d / ms)}${u}`;
  return "just now";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── session record bootstrap ─────────────────────────────
// Per-tab session token; sessionStorage so reloads continue, new tabs
// start fresh. 16 random bytes → 32 hex chars → 128 bits of entropy. The
// only realistic exfil vector is XSS on the customer's site, which is
// game-over independently of session record.
const SESSION_TOKEN_KEY = "crumb_replay_token";

function getOrCreateSessionToken(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch { /* sessionStorage may be blocked; fall through to generate */ }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(SESSION_TOKEN_KEY, token); } catch { /* ignore */ }
  return token;
}

// Recording is consent-gated: we never record until the customer explicitly
// opts in (a checkbox in the compose form). Consent is remembered per-tab so a
// reload mid-session keeps recording without re-asking. Same sessionStorage
// scope as the replay token above.
const CONSENT_KEY = "crumb_replay_consent";
function hasRecordConsent(): boolean {
  try { return sessionStorage.getItem(CONSENT_KEY) === "1"; } catch { return false; }
}
function writeRecordConsent(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(CONSENT_KEY, "1");
    else sessionStorage.removeItem(CONSENT_KEY);
  } catch { /* sessionStorage may be blocked; recording just won't persist */ }
}

let recorderInjected = false;
function ensureRecorder(apiBase: string, workspaceSlug: string, sessionToken: string) {
  if (recorderInjected) return;
  recorderInjected = true;
  const startIfReady = () => {
    if (window.__crumbRecord__) {
      window.__crumbRecord__.start({ apiBase, workspaceSlug, sessionToken });
    }
  };
  if (window.__crumbRecord__) { startIfReady(); return; }
  const s = document.createElement("script");
  s.src = `${apiBase}/widget-record.js`;
  s.async = true;
  s.onload = startIfReady;
  // If the customer's CSP blocks the script, onload won't fire — that's fine,
  // the widget itself keeps working. Document the CSP gotcha in the README.
  document.head.appendChild(s);
}

// ─── main ─────────────────────────────────────────────────
function init(config: Config) {
  // host element
  const host = document.createElement("div");
  host.id = "crumb-widget";
  // `crumb-block` is the opt-out class the recorder bundle reads — keeps
  // the widget out of any session recording it's about to start, so we
  // don't end up with recursive UI playback inside the player.
  host.className = "crumb-block";
  host.style.cssText = "position: fixed; inset: auto 0 0 auto; pointer-events: none; z-index: 2147483647;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);

  // launcher + tooltip. The button carries the loop mark; the bar variants
  // (top/inline) reveal a workspace-name label + CTA via CSS once we set the
  // host's `data-pos`.
  //
  // The launcher reveals immediately using branding cached from a prior visit
  // (or the corner default on first-ever load), then refreshes when /me
  // resolves. On repeat visits the cached position is correct, so there's no
  // corner→bar jump; only a brand-new visitor configured for top/inline sees
  // a one-time settle. This keeps first paint off the /me round-trip.
  host.setAttribute("data-pos", "corner"); // safe default before cache/me apply
  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.setAttribute("aria-label", "Open Crumb feedback");
  launcher.style.pointerEvents = "none";
  launcher.style.opacity = "0";
  launcher.style.transition = "opacity 220ms ease";
  launcher.innerHTML = `${LOOP_LAUNCHER}<span class="launcher-name"></span><span class="launcher-cta">Share feedback</span>`;
  shadow.appendChild(launcher);
  const launcherNameEl = launcher.querySelector(".launcher-name") as HTMLSpanElement;
  const launcherSvg = launcher.querySelector("svg") as SVGSVGElement;
  const launcherCircles = Array.from(launcher.querySelectorAll("svg circle")) as SVGCircleElement[];

  // We can't reliably scale individual SVG <circle> elements via WAAPI in a
  // shadow-root context (transform-box: fill-box has uneven plumbing). We
  // animate two things that DO compose cleanly:
  //   - opacity on each circle (the wave)
  //   - rotation on the whole <svg> (the loop literally loops)
  // The <svg> root is an HTML element, so transforms apply normally.
  launcherSvg.style.transformOrigin = "center";

  const reducedMotion = (typeof window !== "undefined")
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Capture the original SVG opacity attribute so the boot loop returns to
  // the right resting state — circles have varying opacity (0.45 → 1.0) to
  // give the loop its tapered look. We then *remove* the attribute and
  // move the value to inline style: WAAPI animations don't reliably beat a
  // presentation attribute in a shadow root, so the attribute would freeze
  // each circle at its declared value and Motion's keyframes would have
  // no visible effect.
  const restingOpacity = launcherCircles.map(c => parseFloat(c.getAttribute("opacity") ?? "1"));
  for (let i = 0; i < launcherCircles.length; i++) {
    const c = launcherCircles[i]!;
    c.removeAttribute("opacity");
    c.style.opacity = String(restingOpacity[i]);
  }

  let bootSpin: AnimationPlaybackControls | null = null;
  const bootDotAnims: Animation[] = []; // native WAAPI handles per-circle

  function startBootShimmer() {
    if (reducedMotion) return;
    // Two animations compose:
    //   1. Motion drives the <svg> rotation — the loop mark literally
    //      loops while we wait for /me. Linear ease keeps the spin steady
    //      (springs feel wrong on continuous rotation).
    //   2. Each <circle> opacity wave is driven by native element.animate()
    //      because Motion's array form silently no-ops on SVGCircleElement
    //      collections (it doesn't write inline style or attach a WAAPI
    //      animation to them). Native WAAPI handles SVG circles correctly.
    bootSpin = animate(
      launcherSvg,
      { rotate: [0, 360] },
      { duration: 1.6, repeat: Infinity, ease: "linear" },
    );
    for (let i = 0; i < launcherCircles.length; i++) {
      const anim = launcherCircles[i]!.animate(
        [{ opacity: 0.3 }, { opacity: 1 }, { opacity: 0.55 }],
        {
          duration: 1100,
          delay: i * 90,
          iterations: Infinity,
          easing: "cubic-bezier(0.32, 0.72, 0.36, 1)",
        },
      );
      bootDotAnims.push(anim);
    }
  }

  function stopBootShimmerAndSettle() {
    if (bootSpin) { bootSpin.stop(); bootSpin = null; }
    for (const a of bootDotAnims) a.cancel();
    bootDotAnims.length = 0;

    if (reducedMotion) {
      launcherSvg.style.transform = "rotate(0deg)";
      for (let i = 0; i < launcherCircles.length; i++) {
        launcherCircles[i]!.style.opacity = String(restingOpacity[i]);
      }
      return;
    }
    // Settle: SVG snaps to 0deg with an overshoot ease (a small spring
    // counter-rotation past 0 then back). Dots ease into their resting
    // opacity in a quick wave via native WAAPI with fill:'forwards' so
    // they hold the final value after the animation completes.
    animate(
      launcherSvg,
      { rotate: [null, 0] },
      { duration: 0.7, ease: SPRING_OVERSHOOT_EASE },
    );
    for (let i = 0; i < launcherCircles.length; i++) {
      launcherCircles[i]!.animate(
        [{ opacity: 0.7 }, { opacity: restingOpacity[i] ?? 1 }],
        {
          duration: 550,
          delay: i * 50,
          easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
          fill: "forwards",
        },
      );
    }
  }

  // Apply branding (colors, position, name) BEFORE we reveal the launcher,
  // so the loading shimmer plays in the final layout. Then, after the
  // minimum visible boot duration, settle into the static state.
  // Apply branding (colors / position / name) to the launcher. Idempotent —
  // called once on first paint with cached/default values, then again when
  // /me returns with the authoritative values.
  function applyBranding(opts: {
    dot?: string | null;
    bg?: string | null;
    position?: string | null;
    workspaceName?: string | null;
    glass?: boolean | null;
  }) {
    if (opts.dot) launcher.style.setProperty("--crumb-accent", opts.dot);
    if (opts.bg)  launcher.style.setProperty("--crumb-launcher-bg", opts.bg);
    if (opts.position === "corner" || opts.position === "pill" || opts.position === "tab") {
      host.setAttribute("data-pos", opts.position);
    }
    if (opts.workspaceName && launcherNameEl) {
      launcherNameEl.textContent = `Share feedback for ${opts.workspaceName}`;
    }
    if (opts.glass != null) launcher.classList.toggle("glass", opts.glass);
  }

  function settleLauncher(opts: {
    dot?: string | null;
    bg?: string | null;
    position?: string | null;
    workspaceName?: string | null;
    glass?: boolean | null;
  }) {
    applyBranding(opts);

    // Reveal in-place (opacity transition is the entrance) and play a brief
    // branded shimmer, then settle. We no longer gate reveal on /me, so this
    // fires immediately on load.
    launcher.style.opacity = "1";
    launcher.style.pointerEvents = "auto";
    startBootShimmer();

    const elapsed = Date.now() - bootStartedAt;
    const remaining = Math.max(0, MIN_BOOT_MS - elapsed);
    setTimeout(stopBootShimmerAndSettle, remaining);
  }

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.textContent = "Share feedback";
  shadow.appendChild(tooltip);

  // scrim (only visible when expanded)
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.style.pointerEvents = "none";
  shadow.appendChild(scrim);

  // panel
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.pointerEvents = "auto";
  shadow.appendChild(panel);

  // state
  let open = false;
  let expanded = false;
  let items: ItemSummary[] | null = null; // null = not yet loaded
  // Pending attachments for the active reply composer. Cleared on view
  // change or successful send.
  let pendingAttachments: ThreadAttachment[] = [];
  let uploadingAttachment = false;
  let attachmentError: string | null = null;
  let listState: AsyncState = { kind: "idle" };
  let view: View = { kind: "list" };
  let thread: ThreadData | null = null;
  let threadState: AsyncState = { kind: "idle" };
  let roadmap: RoadmapData | null = null;
  let roadmapState: AsyncState = { kind: "idle" };
  let submitState: AsyncState = { kind: "idle" };
  let me: Me | null = null;
  let meState: AsyncState = { kind: "idle" };
  let memberMsg: string | null = null;

  const setView = (v: View) => { view = v; render(); };

  // ── branding cache (instant first paint) ──────────────────
  // Persist /me branding so repeat visits paint the launcher with the correct
  // colors/position immediately — no waiting on the /me round-trip.
  type CachedBrand = { accent?: string; launcher_bg?: string; launcher_glass?: boolean; position?: string; name?: string };
  function brandKey(): string { return `crumb_brand:${config.workspace}`; }
  function readCachedBrand(): CachedBrand | null {
    try { return JSON.parse(localStorage.getItem(brandKey()) || "null"); } catch { return null; }
  }
  function writeCachedBrand(b: CachedBrand): void {
    try { localStorage.setItem(brandKey(), JSON.stringify(b)); } catch { /* storage blocked */ }
  }

  // ── unread watermark (vendor → customer reply signal) ──────
  // localStorage map { short_id: lastSeenReplyCount } per workspace+user. An
  // item is "unread" when its reply_count grew since the customer last opened
  // its thread — i.e. the vendor (or an inbound email) replied while they were
  // away. Drives the launcher badge so a reply is visible on next page load
  // without reopening every thread. Best-effort: if storage is blocked
  // (incognito), getSeen() returns {} and the badge falls back to "any item
  // with replies" — the prior behavior.
  function seenKey(): string {
    return `crumb_seen:${config.workspace}:${config.userEmail || "jwt"}`;
  }
  // Cached so render() (called on every interaction/animation tick) doesn't
  // re-parse localStorage each time. The cache holds the live object; writes
  // mutate it in place.
  let seenCache: Record<string, number> | null = null;
  function getSeen(): Record<string, number> {
    if (seenCache) return seenCache;
    let m: Record<string, number>;
    try { m = JSON.parse(localStorage.getItem(seenKey()) || "{}") || {}; } catch { m = {}; }
    seenCache = m;
    return m;
  }
  // Record the count seen for a thread. Pass the freshly-loaded thread's
  // message count — not the (possibly-unloaded) list — so deep-link / boot
  // opens clear the badge correctly.
  function markThreadSeen(shortId: string, count: number) {
    const m = getSeen();
    m[shortId] = count;
    try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch { /* storage blocked — cache still updated */ }
  }

  // ── network ────────────────────────────────────────────
  function authHeaders(): Record<string, string> {
    return config.jwt ? { Authorization: `Bearer ${config.jwt}` } : {};
  }
  function withAuthParams(u: URL): URL {
    // When a JWT is in flight, the server reads identity from claims —
    // no need to pass workspace/email on the wire.
    if (!config.jwt) {
      u.searchParams.set("workspace", config.workspace);
      u.searchParams.set("email", config.userEmail);
    }
    return u;
  }
  function authBody(extra: Record<string, unknown>): string {
    // For POSTs, JWT identity replaces the body fields. In fallback mode,
    // we still send workspace_slug + account_user_email + account_name so
    // the server can upsert and auth.
    if (config.jwt) return JSON.stringify(extra);
    return JSON.stringify({
      workspace_slug: config.workspace,
      account_user_email: config.userEmail,
      account_user_name: config.userName,
      account_name: config.accountName,
      ...extra,
    });
  }

  async function fetchList() {
    listState = { kind: "loading" };
    render();
    try {
      const u = withAuthParams(new URL(`${config.apiBase}/api/v1/items`));
      const res = await fetch(u.toString(), { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      items = data.items as ItemSummary[];
      listState = { kind: "idle" };
    } catch (err) {
      listState = { kind: "error", message: err instanceof Error ? err.message : "Could not load" };
    }
    render();
  }

  async function fetchMe() {
    meState = { kind: "loading" };
    try {
      const u = withAuthParams(new URL(`${config.apiBase}/api/v1/me`));
      const res = await fetch(u.toString(), { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      me = data as Me;
      meState = { kind: "idle" };
    } catch (err) {
      meState = { kind: "error", message: err instanceof Error ? err.message : "Could not load" };
    }
    // No render here — the launcher handler awaits both before showing the panel.
  }

  async function fetchThread(shortId: string) {
    threadState = { kind: "loading" };
    thread = null;
    render();
    try {
      const u = withAuthParams(new URL(`${config.apiBase}/api/v1/items/${encodeURIComponent(shortId)}`));
      const res = await fetch(u.toString(), { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      thread = data as ThreadData;
      threadState = { kind: "idle" };
      // Viewing the thread clears its unread state — snapshot the just-loaded
      // message count (same units as the list's reply_count) so the launcher
      // badge drops this item, even on a deep-link open before the list loads.
      markThreadSeen(shortId, Array.isArray(thread.messages) ? thread.messages.length : 0);
    } catch (err) {
      threadState = { kind: "error", message: err instanceof Error ? err.message : "Could not load" };
    }
    render();
  }

  async function fetchRoadmap() {
    roadmapState = { kind: "loading" };
    render();
    try {
      const u = withAuthParams(new URL(`${config.apiBase}/api/v1/roadmap`));
      const res = await fetch(u.toString(), { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      roadmap = data as RoadmapData;
      roadmapState = { kind: "idle" };
    } catch (err) {
      roadmapState = { kind: "error", message: err instanceof Error ? err.message : "Could not load" };
    }
    render();
  }

  async function toggleFollow(initiativeId: string, follow: boolean) {
    // Optimistic flip in the cached roadmap, then persist.
    if (roadmap) {
      for (const col of ["now", "next", "later"] as const) {
        const e = roadmap.columns[col].find(x => x.id === initiativeId);
        if (e) e.following = follow;
      }
      render();
    }
    try {
      await fetch(`${config.apiBase}/api/v1/roadmap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: authBody({ initiative_id: initiativeId, follow }),
      });
    } catch {
      // Revert on failure.
      void fetchRoadmap();
    }
  }

  // ── customer notification prefs ──
  async function saveNotif(patch: Partial<NotifPrefs>) {
    if (!me) return;
    if (!me.notifications) me.notifications = { replies: true, status: true, roadmap: true, unsubscribed_all: false };
    Object.assign(me.notifications, patch); // optimistic
    render();
    try {
      const res = await fetch(`${config.apiBase}/api/v1/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: authBody(patch),
      });
      if (!res.ok) throw new Error();
    } catch {
      void fetchMe(); // fall back to server truth
    }
  }

  // ── account member management (admins) ──
  async function setMemberRole(id: string, role: "admin" | "member") {
    if (!me) return;
    memberMsg = null;
    const m = me.members.find(x => x.id === id);
    const prev = m?.role;
    if (m) { m.role = role; render(); }
    try {
      const res = await fetch(`${config.apiBase}/api/v1/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: authBody({ target_user_id: id, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (m && prev) m.role = prev;
        memberMsg = data?.error === "last_admin" ? "An account needs at least one admin." : "Couldn't change that role.";
        render();
      }
    } catch {
      void fetchMe();
    }
  }

  async function removeMember(id: string) {
    if (!me) return;
    memberMsg = null;
    const idx = me.members.findIndex(x => x.id === id);
    if (idx < 0) return;
    const removed = me.members[idx]!;
    me.members.splice(idx, 1);
    me.account.member_count = Math.max(0, me.account.member_count - 1);
    render();
    try {
      const res = await fetch(`${config.apiBase}/api/v1/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: authBody({ target_user_id: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        me.members.splice(idx, 0, removed);
        me.account.member_count += 1;
        memberMsg = data?.error === "has_items"
          ? "This teammate has feedback on file and can't be removed."
          : data?.error === "last_admin"
            ? "An account needs at least one admin."
            : "Couldn't remove that teammate.";
        render();
      }
    } catch {
      void fetchMe();
    }
  }

  async function submitNew(t: Extract<View, { kind: "compose" }>) {
    if (!t.title.trim()) {
      submitState = { kind: "error", message: "Add a one-line title." };
      render();
      return;
    }
    submitState = { kind: "loading" };
    render();
    try {
      // Attach the recording session token if recording is active. The
      // server only links sessions that have ≥1 chunk flushed, so a token
      // here doesn't imply a guaranteed link.
      const sessionToken = window.__crumbRecord__?.getSessionToken?.() ?? undefined;
      const res = await fetch(`${config.apiBase}/api/v1/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: authBody({ type: t.type, title: t.title.trim(), body: t.body.trim(), session_token: sessionToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      submitState = { kind: "idle" };
      await fetchList();
      setView({ kind: "confirm", shortId: data.short_id });
    } catch (err) {
      submitState = { kind: "error", message: err instanceof Error ? err.message : "Could not send." };
      render();
    }
  }

  async function submitReply(t: Extract<View, { kind: "thread" }>) {
    if (!t.reply.trim() && pendingAttachments.length === 0) return;
    submitState = { kind: "loading" };
    render();
    try {
      const attachmentIds = pendingAttachments.map(a => a.id);
      const res = await fetch(`${config.apiBase}/api/v1/items/${encodeURIComponent(t.shortId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: authBody({ body: t.reply.trim(), attachment_ids: attachmentIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      submitState = { kind: "idle" };
      pendingAttachments = [];
      attachmentError = null;
      view = { kind: "thread", shortId: t.shortId, reply: "" };
      await fetchThread(t.shortId);
    } catch (err) {
      submitState = { kind: "error", message: err instanceof Error ? err.message : "Could not send." };
      render();
    }
  }

  async function pickAndUploadAttachment() {
    if (uploadingAttachment) return;
    attachmentError = null;
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      uploadingAttachment = true;
      render();
      try {
        const form = new FormData();
        form.append("file", file);
        // resolveCustomer on the upload endpoint reads from these form
        // fields when no JWT is present — matches the existing widget
        // trusted-email path.
        if (!config.jwt) {
          form.append("workspace_slug", config.workspace);
          form.append("account_user_email", config.userEmail);
        }
        const res = await fetch(`${config.apiBase}/api/v1/uploads`, {
          method: "POST",
          body: form,
          headers: { ...authHeaders() },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          attachmentError = data?.error || `Upload failed (${res.status})`;
        } else {
          pendingAttachments.push({
            id: data.id,
            filename: data.filename,
            content_type: data.content_type,
            size_bytes: data.size_bytes,
          });
        }
      } catch (err) {
        attachmentError = err instanceof Error ? err.message : "Upload failed";
      } finally {
        uploadingAttachment = false;
        render();
      }
    };
    input.click();
  }

  function removePendingAttachment(id: string) {
    pendingAttachments = pendingAttachments.filter(a => a.id !== id);
    render();
  }

  function humanBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  }

  // ── render ─────────────────────────────────────────────
  function render() {
    panel.classList.toggle("open", open);
    panel.classList.toggle("expanded", open && expanded);
    scrim.classList.toggle("show", open && expanded);

    // Unread badge on launcher: items whose reply_count grew since the
    // customer last opened that thread (a vendor/inbound reply they haven't seen).
    const seen = getSeen();
    const unreadCount = items?.reduce((n, it) => n + (it.reply_count > (seen[it.short_id] ?? 0) ? 1 : 0), 0) ?? 0;
    const existingBadge = launcher.querySelector(".badge");
    if (existingBadge) existingBadge.remove();
    if (unreadCount > 0 && !open) {
      // A pulsing attention dot (not a count) — the exact unread items are
      // surfaced inside the list. Cleaner + draws the eye only when new.
      const b = document.createElement("span");
      b.className = "badge";
      launcher.appendChild(b);
    }

    if (!open) return;

    if (view.kind === "list") renderList();
    else if (view.kind === "admin") renderAdmin();
    else if (view.kind === "roadmap") renderRoadmap();
    else if (view.kind === "settings") renderSettings();
    else if (view.kind === "compose") renderCompose(view);
    else if (view.kind === "thread") renderThread(view);
    else if (view.kind === "confirm") renderConfirm(view);
  }

  function tabStripHtml(active: "feedback" | "roadmap" | "admin"): string {
    const showRoadmap = !!me?.has_roadmap;
    const showAdmin = !!me?.is_account_admin;
    // No tabs when there's nothing beyond the feedback list.
    if (!showRoadmap && !showAdmin) return "";
    let tabs = `<button class="tab" data-act="tab" data-tab="feedback" aria-selected="${active === "feedback"}">Your feedback</button>`;
    if (showRoadmap) tabs += `<button class="tab" data-act="tab" data-tab="roadmap" aria-selected="${active === "roadmap"}">Roadmap</button>`;
    if (showAdmin) tabs += `<button class="tab" data-act="tab" data-tab="admin" aria-selected="${active === "admin"}">Admin</button>`;
    return `<div class="tabs">${tabs}</div>`;
  }

  function header(title: string, sub?: string, withBack = false, expandable = false): string {
    return `
      <div class="head">
        ${withBack
          ? `<button class="back" aria-label="Back" data-act="back">${ICONS.back}</button>`
          : `<span class="brand-mark">${LOOP_HEAD}</span>`}
        <div class="title">${escapeHtml(title)}${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>
        ${(!withBack && me?.email_enabled) ? `<button class="close" aria-label="Notification settings" data-act="open-settings">${ICONS.gear}</button>` : ""}
        ${expandable ? `<button class="close" aria-label="${expanded ? "Collapse" : "Expand"}" data-act="toggle-expand">${expanded ? ICONS.collapse : ICONS.expand}</button>` : ""}
        <button class="close" aria-label="Close" data-act="close">${ICONS.x}</button>
      </div>`;
  }

  function statusPillHtml(status: Status): string {
    return `<span class="status-pill"><span class="status-dot ${status}"></span>${STATUS_LABEL[status]}</span>`;
  }

  function renderList() {
    const isLoading = listState.kind === "loading" && items === null;
    let bodyHtml = tabStripHtml("feedback");

    if (isLoading) {
      bodyHtml += `<div class="skeleton">${`<div class="skel row"></div>`.repeat(4)}</div>`;
    } else if (!items || items.length === 0) {
      bodyHtml += `
        <div class="empty">
          <span class="icon">${ICONS.chat}</span>
          <h2>Got something to share?</h2>
          <p>Drop us a crumb — bug, idea, question. We read every one.</p>
          <button class="primary" data-act="new" style="margin-top:8px">
            ${ICONS.plus}<span>Share feedback</span>
          </button>
        </div>`;
    } else {
      bodyHtml += `
        <div class="items-list">
          ${items.map(it => `
            <button class="item-row" data-act="open-thread" data-short="${escapeHtml(it.short_id)}">
              <div class="top">
                <span class="short">${escapeHtml(it.short_id)}</span>
                ${statusPillHtml(it.status)}
                <span class="age">${ageFrom(it.updated_at)}</span>
              </div>
              <div class="title">${escapeHtml(it.title)}</div>
              ${it.reply_count > 1 ? `<div class="bottom">${it.reply_count - 1} ${it.reply_count - 1 === 1 ? "reply" : "replies"}</div>` : ""}
            </button>
          `).join("")}
        </div>
        ${listState.kind === "error" ? `<div class="err">${escapeHtml(listState.message)}</div>` : ""}`;
    }

    panel.innerHTML = `
      ${header("Your feedback", config.accountName)}
      <div class="body">${bodyHtml}</div>
      <div class="foot">
        <div class="row">
          <span class="meta">via Crumb</span>
          <button class="primary" data-act="new">${ICONS.plus}<span>Share feedback</span></button>
        </div>
      </div>`;
  }

  function renderAdmin() {
    if (!me) {
      panel.innerHTML = `
        ${header(config.accountName)}
        ${tabStripHtml("admin")}
        <div class="body"><div class="skeleton"><div class="skel row"></div><div class="skel row"></div></div></div>`;
      return;
    }

    const isAdmin = me.is_account_admin;
    const membersHtml = me.members.length === 0
      ? `<p class="text-sm muted" style="margin:0">No teammates yet.</p>`
      : `<div class="members">${me.members.map(m => {
          const self = m.id === me!.user.id;
          const controls = (isAdmin && !self)
            ? `<div class="member-actions">
                 <button class="member-role" data-act="member-role" data-id="${escapeHtml(m.id)}" data-next="${m.role === "admin" ? "member" : "admin"}" title="Change role">${m.role === "admin" ? "Admin" : "Member"}</button>
                 <button class="member-remove" data-act="member-remove" data-id="${escapeHtml(m.id)}" aria-label="Remove ${escapeHtml(m.name)}">${ICONS.trash}</button>
               </div>`
            : (m.role === "admin" ? `<span class="role-pill">admin</span>` : `<span class="member-count">${m.item_count}</span>`);
          return `<div class="member-row">
            <span class="member-avatar">${escapeHtml(m.initials)}</span>
            <div class="member-meta">
              <span class="member-name">${escapeHtml(m.name)}${self ? ` <span class="member-you">you</span>` : ""}</span>
              <span class="member-email">${escapeHtml(m.email)}</span>
            </div>
            ${controls}
          </div>`;
        }).join("")}
        </div>`;

    panel.innerHTML = `
      ${header(me.account.name, `${me.account.member_count} on ${me.account.name}`)}
      <div class="body">
        ${tabStripHtml("admin")}

        <section class="admin-card">
          <div class="admin-card-head">
            <span class="admin-card-title">Members</span>
            <span class="admin-card-sub">${me.account.member_count} on ${escapeHtml(me.account.name)}</span>
          </div>
          ${memberMsg ? `<div class="err" style="margin-bottom:10px">${escapeHtml(memberMsg)}</div>` : ""}
          ${membersHtml}
          ${isAdmin ? `<p class="set-sub" style="margin:12px 2px 0">Teammates appear here automatically when they open the widget. Change a role or remove someone above.</p>` : ""}
        </section>
      </div>`;
  }

  function renderSettings() {
    const n: NotifPrefs = me?.notifications ?? { replies: true, status: true, roadmap: true, unsubscribed_all: false };
    const paused = n.unsubscribed_all;
    const toggleRow = (key: "replies" | "status" | "roadmap", label: string, sub: string) => {
      const on = n[key] && !paused;
      return `<div class="set-row${paused ? " disabled" : ""}">
        <div class="set-meta"><span class="set-label">${label}</span><span class="set-sub">${sub}</span></div>
        <button class="sw ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-act="notif-toggle" data-key="${key}"${paused ? " disabled" : ""}></button>
      </div>`;
    };
    panel.innerHTML = `
      ${header("Notifications", config.accountName, true)}
      <div class="body">
        <p class="lede" style="margin:0 0 14px">Choose which emails ${escapeHtml(me?.workspace.name ?? "we")} sends you about your feedback.</p>
        ${toggleRow("replies", "Replies", "When the team replies on your feedback")}
        ${toggleRow("status", "Status changes", "When your feedback moves (planned, shipped…)")}
        ${toggleRow("roadmap", "Roadmap updates", "When a roadmap item you follow changes")}
        <div class="set-divider"></div>
        <div class="set-row">
          <div class="set-meta"><span class="set-label">Pause all email</span><span class="set-sub">Mute every notification above</span></div>
          <button class="sw ${paused ? "on" : ""}" role="switch" aria-checked="${paused}" data-act="notif-pause"></button>
        </div>
      </div>`;
  }

  function renderRoadmap() {
    const isLoading = roadmapState.kind === "loading" && roadmap === null;
    let bodyHtml = tabStripHtml("roadmap");

    if (isLoading) {
      bodyHtml += `<div class="skeleton"><div class="skel row"></div><div class="skel row"></div></div>`;
    } else if (roadmapState.kind === "error") {
      bodyHtml += `<div class="err">${escapeHtml(roadmapState.message)}</div>`;
    } else if (roadmap) {
      const cols = [["now", "Now"], ["next", "Next"], ["later", "Later"]] as const;
      const total = cols.reduce((n, [k]) => n + roadmap!.columns[k].length, 0);
      if (total === 0) {
        bodyHtml += `
          <div class="empty">
            <span class="icon">${ICONS.idea}</span>
            <h2>Nothing here yet</h2>
            <p>This team hasn't shared a public roadmap yet — check back soon.</p>
          </div>`;
      } else {
        bodyHtml += `<div class="rm-board">` + cols.map(([key, label]) => {
          const entries = roadmap!.columns[key];
          if (entries.length === 0) return "";
          return `
            <div class="rm-col">
              <div class="rm-col-head">${label}</div>
              ${entries.map(e => `
                <div class="rm-card">
                  <div class="rm-card-top">
                    <span class="rm-name">${escapeHtml(e.name)}</span>
                    <button class="rm-follow${e.following ? " on" : ""}" data-act="follow" data-id="${escapeHtml(e.id)}" data-following="${e.following ? "1" : "0"}">${e.following ? "Following" : "Follow"}</button>
                  </div>
                  ${e.description ? `<p class="rm-desc">${escapeHtml(e.description)}</p>` : ""}
                </div>`).join("")}
            </div>`;
        }).join("") + `</div>`;
      }
    }

    panel.innerHTML = `
      ${header("Roadmap", config.accountName)}
      <div class="body">${bodyHtml}</div>`;
  }

  function renderCompose(v: Extract<View, { kind: "compose" }>) {
    const submitting = submitState.kind === "loading";
    const err = submitState.kind === "error" ? submitState.message : "";
    panel.innerHTML = `
      ${header("Share feedback", undefined, true)}
      <div class="body">
        <p class="lede">Bug, idea, question — we read every one.</p>

        <div>
          <span class="field-label">Type</span>
          <div class="types">
            ${TYPES.map(t => `
              <button class="type-btn" data-act="type" data-type="${t.key}" aria-pressed="${v.type === t.key}">
                ${t.icon}
                <span>${t.label}</span>
              </button>`).join("")}
          </div>
        </div>

        <div>
          <span class="field-label">Title</span>
          <input class="field" data-act="title" placeholder="One line — what's the gist?" />
        </div>

        <div>
          <span class="field-label">Details (optional)</span>
          <textarea class="field" data-act="body" placeholder="Anything else we should know?"></textarea>
        </div>

        ${me?.workspace.session_record_enabled ? `
        <label data-act="record-consent-row" style="display:flex;gap:8px;align-items:flex-start;margin-top:2px;cursor:pointer">
          <input type="checkbox" data-act="record-consent" ${hasRecordConsent() ? "checked" : ""} style="margin-top:2px;flex:none" />
          <span style="display:flex;flex-direction:column;gap:2px">
            <span style="font-size:13px;font-weight:600">Record my session to help us reproduce this</span>
            <span style="font-size:11px;opacity:.65;line-height:1.45">Captures your actions and network requests on this page so the team can debug. What you type is hidden. You can turn this off anytime.</span>
          </span>
        </label>` : ""}

        ${err ? `<div class="err">${escapeHtml(err)}</div>` : ""}
      </div>
      <div class="foot">
        <div class="row">
          <span class="meta">${escapeHtml(config.userName ? `Posting as ${config.userName} · ${config.accountName}` : config.accountName)}</span>
          <button class="primary" data-act="submit" ${submitting ? "disabled" : ""}>
            ${ICONS.send}<span>${submitting ? "Sending…" : "Send"}</span>
          </button>
        </div>
      </div>`;

    // restore typed values
    const titleEl = panel.querySelector<HTMLInputElement>('input[data-act="title"]');
    const bodyEl = panel.querySelector<HTMLTextAreaElement>('textarea[data-act="body"]');
    if (titleEl) titleEl.value = v.title;
    if (bodyEl)  bodyEl.value  = v.body;
  }

  function renderThread(v: Extract<View, { kind: "thread" }>) {
    const isLoading = threadState.kind === "loading" || thread === null || thread.item.short_id !== v.shortId;
    let body = "";
    let footMeta = "";

    if (isLoading) {
      body = `<div class="skeleton"><div class="skel row"></div><div class="skel row" style="height:96px"></div><div class="skel row" style="height:64px"></div></div>`;
    } else if (threadState.kind === "error") {
      body = `<div class="err">${escapeHtml(threadState.message)}</div>`;
    } else if (thread) {
      const msgs = thread.messages.map(m => {
        const atts = (m.attachments ?? []).map(a => `
          <a class="attachment" href="${escapeHtml(config.apiBase)}/api/v1/uploads/${escapeHtml(a.id)}" target="_blank" rel="noreferrer">
            ${ICONS.attach}
            <span class="filename">${escapeHtml(a.filename)}</span>
            <span class="size">${humanBytes(a.size_bytes)}</span>
          </a>`).join("");
        return `
          <div class="msg ${m.kind === "vendor" ? "vendor" : ""}">
            <div class="meta">
              <span class="avatar">${escapeHtml(m.author_initials)}</span>
              <span>${escapeHtml(m.author_name)}</span>
              <span class="when">${ageFrom(m.created_at)}</span>
            </div>
            ${m.body ? `<p>${escapeHtml(m.body)}</p>` : ""}
            ${atts ? `<div class="attachments">${atts}</div>` : ""}
          </div>`;
      }).join("");

      // Status timeline — visible in the expanded side rail, hidden when collapsed.
      const eventsHtml = thread.events.map(e => {
        const isInitial = e.from_status === null;
        const label = isInitial ? "Submitted" : (STATUS_LABEL[e.to_status as Status] ?? e.to_status);
        const reasonHtml = e.reason
          ? `<div class="event-reason">${escapeHtml(e.reason)}</div>`
          : "";
        return `<div class="event">
          <span class="event-dot status-dot ${e.to_status}"></span>
          <span class="event-label">${escapeHtml(label)}</span>
          <span class="event-age">${ageFrom(e.at)}</span>
          ${reasonHtml}
        </div>`;
      }).join("");

      body = `
        <div class="thread-grid">
          <div class="thread-messages">
            <div class="thread-meta">
              <span class="short-id">${escapeHtml(thread.item.short_id)}</span>
              ${statusPillHtml(thread.item.status)}
            </div>
            ${msgs || `<p class="lede">No messages yet.</p>`}
          </div>
          <aside class="status-rail">
            <div class="rail-heading">Status</div>
            ${eventsHtml || `<p class="lede" style="margin:0">No history yet.</p>`}
          </aside>
        </div>
      `;
      footMeta = thread.workspace.name;
    }

    const submitting = submitState.kind === "loading";
    const submitErr = submitState.kind === "error" ? submitState.message : "";
    // Prefer the loaded thread title; fall back to the list-row title we
    // already have in memory (so the header doesn't flash "FB-N" while
    // /thread is fetching); last resort is the shortId.
    const listRowTitle = items?.find(it => it.short_id === v.shortId)?.title;
    const headerTitle = thread?.item.title ?? listRowTitle ?? v.shortId;
    panel.innerHTML = `
      ${header(headerTitle, footMeta || undefined, true, true)}
      <div class="body">${body}</div>
      <div class="foot">
        ${submitErr ? `<div class="err">${escapeHtml(submitErr)}</div>` : ""}
        ${attachmentError ? `<div class="err">${escapeHtml(attachmentError)}</div>` : ""}
        ${pendingAttachments.length > 0 ? `
          <div class="pending-attachments">
            ${pendingAttachments.map(a => `
              <span class="pending-attachment">
                ${ICONS.attach}
                <span class="filename">${escapeHtml(a.filename)}</span>
                <span class="size">${humanBytes(a.size_bytes)}</span>
                <button data-act="remove-attachment" data-id="${escapeHtml(a.id)}" aria-label="Remove">${ICONS.x}</button>
              </span>`).join("")}
          </div>
        ` : ""}
        <div class="row">
          <button class="ghost" data-act="pick-attachment" aria-label="Attach file" ${uploadingAttachment ? "disabled" : ""}>
            ${ICONS.attach}
          </button>
          <input class="field" data-act="reply" placeholder="${uploadingAttachment ? "Uploading…" : "Reply…"}" style="flex:1" />
          <button class="primary" data-act="send-reply" ${submitting || uploadingAttachment ? "disabled" : ""}>
            ${ICONS.send}<span>${submitting ? "…" : "Send"}</span>
          </button>
        </div>
      </div>`;
    const replyEl = panel.querySelector<HTMLInputElement>('input[data-act="reply"]');
    if (replyEl) {
      replyEl.value = v.reply;
      // re-focus after re-render so typing isn't interrupted
      if (document.activeElement !== replyEl) replyEl.focus();
    }
  }

  function renderConfirm(v: Extract<View, { kind: "confirm" }>) {
    panel.innerHTML = `
      ${header("Crumb received", undefined, false)}
      <div class="body">
        <div class="empty">
          <span class="icon">${ICONS.check}</span>
          <h2>Crumb received.</h2>
          <p>We’ll be in touch — usually a reply within a day.</p>
          <span class="short-id">${escapeHtml(v.shortId)}</span>
        </div>
      </div>
      <div class="foot">
        <div class="row">
          <button class="outline" data-act="see-list">See your feedback</button>
          <div class="spacer"></div>
          <button class="primary" data-act="new">${ICONS.plus}<span>Send another</span></button>
        </div>
      </div>`;
  }

  // ── event delegation ───────────────────────────────────
  panel.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!target) return;
    const act = target.dataset.act;

    if (act === "close") { open = false; expanded = false; render(); return; }
    if (act === "toggle-expand") { expanded = !expanded; render(); return; }
    if (act === "back") {
      submitState = { kind: "idle" };
      memberMsg = null;
      expanded = false;
      setView({ kind: "list" });
      return;
    }
    if (act === "tab") {
      const t = target.dataset.tab;
      memberMsg = null;
      if (t === "admin") setView({ kind: "admin" });
      else if (t === "feedback") setView({ kind: "list" });
      else if (t === "roadmap") { setView({ kind: "roadmap" }); if (roadmap === null) fetchRoadmap(); }
      return;
    }
    if (act === "open-settings") { memberMsg = null; setView({ kind: "settings" }); return; }
    if (act === "notif-toggle") {
      const key = target.dataset.key;
      if ((key === "replies" || key === "status" || key === "roadmap") && me?.notifications && !me.notifications.unsubscribed_all) {
        saveNotif({ [key]: !me.notifications[key] } as Partial<NotifPrefs>);
      }
      return;
    }
    if (act === "notif-pause") {
      saveNotif({ unsubscribed_all: !(me?.notifications?.unsubscribed_all ?? false) });
      return;
    }
    if (act === "member-role") {
      const id = target.dataset.id;
      const next = target.dataset.next;
      if (id && (next === "admin" || next === "member")) setMemberRole(id, next);
      return;
    }
    if (act === "member-remove") {
      const id = target.dataset.id;
      if (id) removeMember(id);
      return;
    }
    if (act === "follow") {
      const id = target.dataset.id;
      if (id) toggleFollow(id, target.dataset.following !== "1");
      return;
    }
    if (act === "new") {
      submitState = { kind: "idle" };
      setView({ kind: "compose", type: "idea", title: "", body: "" });
      return;
    }
    if (act === "see-list") {
      setView({ kind: "list" });
      return;
    }
    if (act === "open-thread") {
      const sid = target.dataset.short;
      if (!sid) return;
      submitState = { kind: "idle" };
      setView({ kind: "thread", shortId: sid, reply: "" });
      fetchThread(sid);
      return;
    }
    if (act === "type" && view.kind === "compose") {
      const t = target.dataset.type as ItemType | undefined;
      if (t) setView({ ...view, type: t });
      submitState = { kind: "idle" };
      return;
    }
    if (act === "record-consent") {
      // Customer-triggered recording. Checking the box starts rrweb now (the
      // session_token links to whatever they submit); unchecking stops it.
      const on = (target as HTMLInputElement).checked;
      writeRecordConsent(on);
      if (on) ensureRecorder(config.apiBase, config.workspace, getOrCreateSessionToken());
      else { try { window.__crumbRecord__?.stop(); } catch { /* ignore */ } }
      return;
    }
    if (act === "submit" && view.kind === "compose") {
      submitNew(view);
      return;
    }
    if (act === "send-reply" && view.kind === "thread") {
      submitReply(view);
      return;
    }
    if (act === "pick-attachment") {
      pickAndUploadAttachment();
      return;
    }
    if (act === "remove-attachment") {
      const id = target.closest("[data-id]")?.getAttribute("data-id");
      if (id) removePendingAttachment(id);
      return;
    }
  });

  panel.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    const act = (target as HTMLInputElement | HTMLTextAreaElement).dataset?.act;
    if (!act) return;
    if (view.kind === "compose") {
      if (act === "title") { view = { ...view, title: (target as HTMLInputElement).value }; }
      if (act === "body")  { view = { ...view, body:  (target as HTMLTextAreaElement).value }; }
      submitState = { kind: "idle" };
    } else if (view.kind === "thread" && act === "reply") {
      view = { ...view, reply: (target as HTMLInputElement).value };
    }
  });

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && view.kind === "thread") {
      const target = e.target as HTMLElement;
      if ((target as HTMLInputElement).dataset?.act === "reply" && !e.shiftKey) {
        e.preventDefault();
        submitReply(view);
      }
    }
  });

  scrim.addEventListener("click", () => {
    if (expanded) { expanded = false; render(); }
  });

  launcher.addEventListener("click", () => {
    open = !open;
    if (open) {
      // Always refresh on open so the list (and any new vendor replies) is
      // current. render() inside fetchList shows the panel once items arrive;
      // /me has usually already finished from the init kickoff.
      if (me === null && meState.kind !== "loading") fetchMe();
      fetchList();
    } else {
      render();
    }
  });

  // First paint must NOT wait on the /me round-trip (which can be 1–3s on a
  // cold serverless function or dev compile). We reveal the launcher
  // immediately using branding cached from a previous visit — or safe corner
  // defaults on the very first ever load — then refresh colors/position in
  // place when /me resolves and cache it for next time.
  const bootStartedAt = Date.now();
  const MIN_BOOT_MS = 600; // brief branded entrance shimmer, not a loading gate

  const cachedBrand = readCachedBrand();
  settleLauncher({
    dot: cachedBrand?.accent ?? null,
    bg: cachedBrand?.launcher_bg ?? null,
    position: cachedBrand?.position ?? null,
    workspaceName: cachedBrand?.name ?? null,
    glass: cachedBrand?.launcher_glass ?? null,
  });

  fetchMe().then(() => {
    if (me) {
      applyBranding({
        dot: me.workspace.accent ?? null,
        bg: me.workspace.launcher_bg ?? null,
        position: me.workspace.position ?? null,
        workspaceName: me.workspace.name ?? null,
        glass: me.workspace.launcher_glass ?? false,
      });
      writeCachedBrand({
        accent: me.workspace.accent,
        launcher_bg: me.workspace.launcher_bg,
        launcher_glass: me.workspace.launcher_glass,
        position: me.workspace.position,
        name: me.workspace.name,
      });
      // Consent-gated: only (re)start recording if the customer already opted
      // in earlier this tab. A fresh visitor records nothing until they tick
      // the box in the compose form.
      if (me.workspace.session_record_enabled && hasRecordConsent()) {
        ensureRecorder(config.apiBase, config.workspace, getOrCreateSessionToken());
      }
    }
  });

  // Background-load the list once on boot so the launcher can surface an
  // unread badge for replies that arrived while the customer was away —
  // before they ever open the panel. Cheap single GET; failures are silent.
  fetchList();

  // Honor `?crumb_open=FB-N` on initial load — the deep-link target in
  // customer notification emails. Pops the panel straight to that thread.
  function maybeAutoOpen() {
    try {
      const q = new URLSearchParams(location.search);
      const sid = q.get("crumb_open");
      if (!sid) return;
      open = true;
      fetchMe();
      fetchList();
      view = { kind: "thread", shortId: sid, reply: "" };
      fetchThread(sid);
    } catch {
      /* host page may sandbox URLSearchParams; ignore */
    }
  }
  maybeAutoOpen();

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open) return;
    // Two-stage: collapse first, then close. Mirrors the way most modals
    // dismiss a deeper layer before closing the whole thing.
    if (expanded) { expanded = false; render(); }
    else { open = false; render(); }
  });

  render();
}

const cfg = readConfig();
if (cfg) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init(cfg), { once: true });
  } else {
    init(cfg);
  }
}
