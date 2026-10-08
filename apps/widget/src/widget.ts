// Crumb embed widget — vanilla TS, shadow DOM, no framework.
// Loaded via:
//   <script src="https://your-crumb-host/widget.js"
//           data-workspace="southbeam"
//           data-user-email="maya@acme.co"
//           data-user-name="Maya"
//           data-account-name="Acme Co"
//           defer></script>

import { css } from "./styles"; // minified at build time (build.mjs)
import { en, pickLocale, timeFormat, type Strings } from "./strings";
import { redactUrl } from "./redact"; // the recorder's too: page URLs never carry secrets out

// The customer's words, in the widget's language (init() picks it; English
// until then, and in unit tests).
let t: Strings = en;

type ItemType = "bug" | "idea" | "question";

type Status =
  | "open" | "review" | "planned" | "progress"
  | "shipped" | "declined" | "deferred" | "duplicate"
  // Set when the customer closes their own request from this widget.
  | "resolved";

// "auto" and "always" are one behaviour, Shown: the widget has no rule that
// would hide the tab on its own, so both paint it. Both values stay valid
// because workspaces have them saved; only "hidden" changes anything.
type LauncherVisibility = "auto" | "always" | "hidden";

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
  /** Per-embed `data-launcher` override. When set it wins over the
   *  workspace's launcherVisibility — lets one page hide crumb's tab
   *  (e.g. it already runs Intercom) while others keep it. */
  launcherOverride?: LauncherVisibility;
  /** Per-embed `data-offset` (px). Vertical nudge along the docked edge
   *  (positive = down from center) so the tab clears anything the host
   *  renders mid-edge. */
  offsetY?: number;
  /** `data-record-network-bodies="true"`: session record also keeps request
   *  and response bodies (secrets redacted). Off unless the host sets it. */
  recordNetworkBodies: boolean;
  /** `data-app-version`: the host app's build, sent with each new request. */
  appVersion?: string;
  /** `data-locale`: the widget's language (BCP 47), ahead of the page's
   *  <html lang> and the browser's. */
  locale?: string;
};

// ─── public JS API ─────────────────────────────────────────
// `window.crumb` is the public surface a host page drives — open the panel
// from their own button or existing chat widget, and record usage events.
// (Distinct from the internal `window.__crumbRecord__` recorder bundle.)
type CrumbApi = {
  /** Open the panel; pass a short id (e.g. "FB-12") to jump to that thread. */
  open: (shortId?: string) => void;
  close: () => void;
  toggle: () => void;
  /** Record a product-usage event for the identified account/user. */
  track: (name: string, props?: Record<string, unknown>) => void;
  /** Fires once the widget has mounted (immediately if already mounted). */
  onReady: (cb: () => void) => void;
  /** Fires with the unread-reply count whenever it changes — lets a host
   *  badge their own launcher when crumb's is hidden. */
  onUnread: (cb: (count: number) => void) => void;
  /** Sign a customer in, or swap in a fresh token, without a page reload.
   *  Reloads their data in place; a different customer replaces the last
   *  one's state entirely. Works before mount (the script can run before
   *  login) and after. */
  identify: (opts: { jwt: string }) => void;
  /** Sign out: forget the customer's data, drafts and unread state, and hide
   *  the launcher until the next identify(). */
  shutdown: () => void;
  /** Fires when the API says the identity token expired, so the host can
   *  mint a new one and call identify(). Once per token. */
  onTokenExpired: (cb: () => void) => void;
  /** Which build of your app the customer is on (same as data-app-version);
   *  sent with each new request. The page and browser are read for you. */
  setContext: (ctx: { app_version?: string | null }) => void;
  /** Internal: queued calls awaiting mount; drained by init(). */
  q?: Array<[keyof CrumbApi, unknown[]]>;
  /** Internal: guards against a double-injected snippet. */
  __mounted?: boolean;
};

declare global {
  interface Window {
    crumb?: CrumbApi;
  }
}

// Install a queuing stub the moment widget.js executes (the script is
// `defer`, so a host's onclick="crumb.open()" or early crumb.track() must not
// throw before init() runs). init() swaps in the real implementation and
// replays the queue — the same stub-then-hydrate pattern Intercom/Segment use.
function installApiStub(): void {
  if (window.crumb) return; // already a stub, or already mounted
  const q: Array<[keyof CrumbApi, unknown[]]> = [];
  const enqueue = (name: keyof CrumbApi) =>
    ((...args: unknown[]) => { q.push([name, args]); }) as never;
  window.crumb = {
    open: enqueue("open"),
    close: enqueue("close"),
    toggle: enqueue("toggle"),
    track: enqueue("track"),
    onReady: enqueue("onReady"),
    onUnread: enqueue("onUnread"),
    identify: enqueue("identify"),
    shutdown: enqueue("shutdown"),
    onTokenExpired: enqueue("onTokenExpired"),
    setContext: enqueue("setContext"),
    q,
  };
}

type LoopTurn = "yours" | "waiting" | "closed";

// The latest customer-visible event on an item — a reply or a status change.
// Computed server-side so the launcher can phrase loop news ("Maya replied",
// "Shipped: …") without re-deriving loop semantics client-side.
type LastEvent = { kind: "reply" | "status"; at: string; status?: Status; author_name?: string | null };

type ItemSummary = {
  short_id: string;
  title: string;
  // Present so the widget can search across the full description text, not just
  // the title. Optional: older payloads (pre body-in-list) omit it.
  body?: string;
  type: ItemType;
  status: Status;
  created_at: string;
  updated_at: string;
  reply_count: number;
  last_reply_side?: "vendor" | "customer" | null;
  turn?: LoopTurn;
  last_event?: LastEvent | null;
  // List only: replies the vendor wrote (never the customer's own), for unread.
  vendor_reply_count?: number;
  last_vendor_reply_at?: string | null;
  // Thread only: why the current status was set, if the vendor said, and when.
  status_reason?: string | null;
  status_changed_at?: string | null;
};

type ThreadAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Short-lived signed link from the thread payload (not on pending uploads). */
  url?: string;
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
  | { kind: "news" }
  | { kind: "settings" }
  | { kind: "compose"; type: ItemType; title: string; body: string }
  | { kind: "thread"; shortId: string; reply: string }
  | { kind: "confirm"; shortId: string };

// Now, Next and Later, then Recently shipped (the most recent few).
const LANES = ["now", "next", "later", "shipped"] as const;
type Lane = (typeof LANES)[number];
type RoadmapEntry = { id: string; short_id: string; name: string; description: string | null; status: string; following: boolean; lane?: Lane; shipped_at?: string | null };
type RoadmapData = { columns: Partial<Record<Lane, RoadmapEntry[]>> };

// A published changelog entry ("What's new"), newest first from the API.
export type NewsEntry = { id: string; title: string; body: string; published_at: string | null };

type NotifPrefs = { replies: boolean; status: boolean; roadmap: boolean; unsubscribed_all: boolean };
type Me = {
  user: { id: string; name: string; email: string; initials: string; role: string };
  workspace: { slug: string; name: string; accent?: string; launcher_bg?: string; launcher_edge?: string; session_record_enabled?: boolean; usage_tracking_enabled?: boolean; launcher_visibility?: LauncherVisibility; launcher_offset_y?: number };
  account: { id: string; name: string; member_count: number };
  is_account_admin: boolean;
  has_roadmap?: boolean;
  // Only true when the deployment can actually send email — gates the
  // Notifications view (no point offering prefs we can't deliver).
  email_enabled?: boolean;
  notifications?: NotifPrefs;
  members: Array<{ id: string; name: string; email: string; initials: string; role: string; item_count: number }>;
};

// `message` is always customer copy (see friendlyError); `code` is the API's
// raw code, kept only to pick the way forward, never shown.
type AsyncState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; code?: string };

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
  // No identity at all is fine: the script may run before login, and the
  // widget waits for crumb.identify({ jwt }). Half an email identity isn't.
  if (!jwt && userEmail && !accountName) missing.push("data-account-name");
  if (missing.length) {
    console.warn(
      `[crumb] widget did not mount: missing required attribute${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
      `See your Crumb dashboard's Settings → Install for the full embed snippet.`,
    );
    return null;
  }

  const explicitApi = d("api");
  const apiBase = explicitApi || new URL(script.src, location.href).origin || location.origin;

  const launcherAttr = d("launcher");
  const launcherOverride =
    launcherAttr === "auto" || launcherAttr === "always" || launcherAttr === "hidden"
      ? (launcherAttr as LauncherVisibility)
      : undefined;
  // data-offset is a single px value: vertical nudge along the docked edge.
  // (Accepts the legacy "x,y" form by reading the y component.)
  const offsetRaw = d("offset");
  let offsetY: number | undefined;
  if (offsetRaw) {
    const parts = offsetRaw.split(",").map(s => parseInt(s.trim(), 10));
    const y = parts.length > 1 ? parts[1] : parts[0];
    if (y != null && Number.isFinite(y)) offsetY = y;
  }

  return {
    workspace,
    jwt,
    userEmail: userEmail || "",
    userName: d("userName") || undefined,
    accountName: accountName || "",
    apiBase,
    launcherOverride,
    offsetY,
    recordNetworkBodies: d("recordNetworkBodies") === "true",
    appVersion: d("appVersion") || undefined,
    locale: d("locale") || undefined,
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
  screen:   `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.25V14"/></svg>`,
  gear:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.4v1.7M8 12.9v1.7M14.6 8h-1.7M3.1 8H1.4M12.66 3.34l-1.2 1.2M4.54 11.46l-1.2 1.2M12.66 12.66l-1.2-1.2M4.54 4.54l-1.2-1.2"/></svg>`,
  trash:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8"/></svg>`,
  alert:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.75v4M8 11.25v.01"/></svg>`,
};

const TYPES: ItemType[] = ["bug", "idea", "question"];

// Statuses worth interrupting the customer for: their loop moved somewhere
// meaningful (committed, in motion, or closed with an outcome). open/review/
// deferred/duplicate are vendor bookkeeping — the launcher stays quiet.
const NEWS_STATUSES = new Set<Status>(["planned", "progress", "shipped", "declined"]);

// Statuses where the loop is already closed — the customer has nothing left to
// do, so the "close this request" affordance is hidden.
const CLOSED_STATUSES = new Set<Status>(["shipped", "declined", "duplicate", "resolved"]);

// An initiative's status in the customer's words: its request-status twin
// (the dashboard's initiative pill uses the same dots).
const INITIATIVE_STATUS: Record<string, Status> = { open: "open", in_progress: "progress", shipped: "shipped", parked: "deferred" };

// Text and double-quoted attribute values alike: a teammate named
// `x" onfocus="…` must not break out of aria-label="Remove ${name}".
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── errors, limits, identity (pure; unit-tested) ─────────
// Field caps: LIMITS in apps/dashboard/lib/validation.ts (a unit test pins
// them together), so the box stops taking text before the API would refuse it.
export const MAX_LEN = { title: 300, body: 20_000, reply: 20_000 } as const;

// Customer copy for an API error code, or the HTTP status when the body had
// none. The code itself never reaches the screen.
export function friendlyError(code: string, status = 0): string {
  switch (code) {
    case "jwt_expired":    return t.errExpired;
    case "network":        return t.errOffline;
    case "not_your_item":  return t.errNotYours;
    case "item_not_found": return t.errNotFound;
    case "missing_title":  return t.errNoTitle;
    case "missing_body":   return t.errNoBody;
    case "empty_file":     return t.errEmptyFile;
    // Marked as spam: final, so nothing that invites another try.
    case "submitter_blocked": return t.errBlocked;
  }
  if (code === "rate_limited" || status === 429) return t.errTooMany;
  if (code === "file_too_large" || status === 413) return t.errTooBig;
  if (code === "unsupported_type" || status === 415) return t.errFileType;
  if (/_too_long$/.test(code)) return t.errTooLong;
  if (status === 401 || /^(jwt_|invalid_token|missing_(email|workspace)|user_not_found)/.test(code)) return t.errSignIn;
  return t.errServer;
}

// Cmd/Ctrl+Enter sends; plain Enter is a newline. Never mid-IME: Chinese and
// Japanese input confirm a candidate with Enter (Safari reports that keydown
// as keyCode 229 with isComposing already false).
export function isSendShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "isComposing" | "keyCode">): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing && e.keyCode !== 229;
}

// The customer a token names (`sub`, their email), read unverified: it only
// keys this tab's drafts and spots a user switch. The API does the verifying.
export function jwtSub(jwt: string): string {
  try {
    const sub = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}

// Grow a textarea with its text up to its CSS max-height, where it scrolls.
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`; // + the 1px borders (border-box)
}

// ─── accessibility (pure; unit-tested) ────────────────────
// The launcher's accessible name: its visible label plus the unread count.
export function launcherLabel(unread: number): string {
  return unread > 0 ? `${t.feedback}, ${t.updates(unread)}` : t.feedback;
}

// Arrow keys move along the tablist (wrapping), Home/End jump to its ends.
// -1: a key the tablist leaves alone.
export function tabStep(key: string, i: number, n: number): number {
  switch (key) {
    case "ArrowRight": return (i + 1) % n;
    case "ArrowLeft":  return (i - 1 + n) % n;
    case "Home":       return 0;
    case "End":        return n - 1;
  }
  return -1;
}

// ─── the customer's loop (pure; unit-tested) ──────────────
// What's new on one request since the customer last looked: a vendor reply
// they haven't opened, or a status move worth interrupting them for. Only the
// vendor's replies count; the customer's own messages are never news.
export function itemNews(it: ItemSummary, seenReplies = 0, seenStatus?: string): { reply: boolean; status: boolean } {
  return {
    reply: (it.vendor_reply_count ?? 0) > seenReplies,
    status: NEWS_STATUSES.has(it.status) && seenStatus !== it.status,
  };
}

// What's new since the customer last looked: a changelog entry published
// after the newest one they had seen. Never looked on this device: all are.
export function newsUnseen(e: NewsEntry, seenAt: string | null): boolean {
  return !seenAt || Date.parse(e.published_at ?? "") > Date.parse(seenAt);
}

// A returning customer's first load since unread moved to its own key (the old
// crumb_seen: map counted every message, theirs too, so it can't say which
// vendor replies they read): every vendor reply so far counts as read, so the
// update lights nothing. Replies from here on are news as usual.
export function seedSeen(list: ItemSummary[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const it of list) seen[it.short_id] = it.vendor_reply_count ?? 0;
  return seen;
}

// The launcher's words for it: "Sam replied" / "Shipped: Dark mode". The
// latest event is the vendor's reply only when its time is their last
// reply's; otherwise the customer wrote last and has no name to show.
export function newsPhrase(it: ItemSummary, news: { reply: boolean; status: boolean }): string {
  const e = it.last_event;
  if (news.reply && !(news.status && e?.kind === "status")) {
    return e?.kind === "reply" && e.at === it.last_vendor_reply_at && e.author_name ? t.replied(e.author_name) : t.newReply;
  }
  return t.statusNews(t.statuses[it.status], it.title);
}

// The vendor's reason for where a request stands, shown in plain words atop
// the thread. Not for "open" (a reopen reads "Unmerged") or "resolved" (the
// customer's own close note).
export function statusReason(it: ItemSummary): string {
  return it.status === "open" || it.status === "resolved" ? "" : it.status_reason?.trim() ?? "";
}

// The vendor's accent, when white text on it reads at 4.5:1 (it fills the
// primary button and draws the focus ring); null keeps the panel's own ink.
export function readableAccent(color: string | null | undefined): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color?.trim() ?? "");
  if (!m) return null;
  const hex = m[1]!.length === 3 ? m[1]!.replace(/./g, "$&$&") : m[1]!;
  const lum = [0.2126, 0.7152, 0.0722].reduce((sum, w, i) => {
    const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
    return sum + w * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }, 0);
  return 1.05 / (lum + 0.05) >= 4.5 ? `#${hex}` : null;
}

// A control's identity across a re-render (render() rebuilds the panel's
// markup): its action plus the item, tab, type or setting it acts on, else
// its id (a heading focus was moved to).
function controlKey(el: HTMLElement): string {
  const d = el.dataset;
  return d.act ? [d.act, d.short, d.id, d.tab, d.type, d.key].join("|") : el.id ? `#${el.id}` : "";
}

// ─── fuzzy search ─────────────────────────────────────────
// Tiny dependency-free subsequence matcher: every char of the (lowercased)
// query must appear in order within the text. Score rewards contiguous runs
// and matches at word boundaries (start, after a space/-/_/digit boundary) so
// "rpl strg" still finds "Replay storage" but ranks exact-ish hits higher.
// Returns -1 when the query isn't a subsequence of the text.
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  if (!text) return -1;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0; // length of the current contiguous match streak
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi]!;
    const found = t.indexOf(c, ti);
    if (found === -1) return -1;
    // Boundary bonus: matching the first char or one right after a separator.
    const prev = found > 0 ? t[found - 1]! : " ";
    const atBoundary = found === 0 || prev === " " || prev === "-" || prev === "_" || prev === "/";
    run = found === ti ? run + 1 : 1; // contiguous with the previous match?
    score += 1 + run + (atBoundary ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

// Best score across an item's searchable fields, weighted title > id > body.
function scoreItem(query: string, it: ItemSummary): number {
  const title = fuzzyScore(query, it.title);
  const id = fuzzyScore(query, it.short_id);
  const body = fuzzyScore(query, it.body ?? "");
  const best = Math.max(title * 3, id * 2, body);
  // Math.max of all-(-1) fields collapses to a negative — treat as no match.
  return title < 0 && id < 0 && body < 0 ? -1 : best;
}

// Best score across a roadmap entry's name (weighted) and description.
function scoreRoadmap(query: string, e: RoadmapEntry): number {
  const name = fuzzyScore(query, e.name);
  const desc = fuzzyScore(query, e.description ?? "");
  return name < 0 && desc < 0 ? -1 : Math.max(name * 2, desc);
}

// ─── session record bootstrap ─────────────────────────────
// Per-tab session token; sessionStorage so reloads continue, new tabs
// start fresh. 16 random bytes → 32 hex chars → 128 bits of entropy. The
// only realistic exfil vector is XSS on the customer's site, which is
// game-over independently of session record.
const SESSION_TOKEN_KEY = "crumb_replay_token";

function storedSessionToken(): string | null {
  try {
    const t = sessionStorage.getItem(SESSION_TOKEN_KEY);
    return t && /^[0-9a-f]{32}$/.test(t) ? t : null;
  } catch { return null; } // sessionStorage may be blocked
}

function getOrCreateSessionToken(): string {
  const existing = storedSessionToken();
  if (existing) return existing;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(SESSION_TOKEN_KEY, token); } catch { /* ignore */ }
  return token;
}

// Recording is consent-gated: nothing is sent until the customer explicitly
// opts in (a checkbox in the compose form). The choice is remembered per tab,
// so a reload mid-session keeps it, and it belongs to that customer: whoever is
// signed in next on this tab starts unasked, with a session of their own.
// "off" is an explicit no, which also keeps the pre-consent buffer off until
// they tick again. Same sessionStorage scope as the replay token above.
const CONSENT_KEY = "crumb_replay_consent";
function recordChoice(owner: string): "on" | "off" | null {
  try {
    const v = sessionStorage.getItem(CONSENT_KEY);
    return v === `on:${owner}` ? "on" : v === `off:${owner}` ? "off" : null;
  } catch { return null; }
}
function writeRecordChoice(owner: string, on: boolean): void {
  try {
    // Withdrawn, or someone else's session on this tab: the next consent
    // starts a fresh one.
    if (!on || !sessionStorage.getItem(CONSENT_KEY)?.endsWith(`:${owner}`)) sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.setItem(CONSENT_KEY, `${on ? "on" : "off"}:${owner}`);
  } catch { /* sessionStorage may be blocked; recording just won't persist */ }
}
function clearRecordChoice(): void {
  try { sessionStorage.removeItem(CONSENT_KEY); sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch { /* ignore */ }
}

// The recorder is its own bundle, loaded once /me says the workspace records.
// `ready` runs when it's there (and again on each later call).
let recorderInjected = false;
function loadRecorder(apiBase: string, ready: () => void) {
  if (window.__crumbRecord__) { ready(); return; }
  if (recorderInjected) return; // still loading: its onload runs `ready`
  recorderInjected = true;
  const s = document.createElement("script");
  s.src = `${apiBase}/widget-record.js`;
  s.async = true;
  s.onload = ready;
  // If the customer's CSP blocks the script, onload won't fire — that's fine,
  // the widget itself keeps working. Document the CSP gotcha in the README.
  document.head.appendChild(s);
}

// ─── main ─────────────────────────────────────────────────
function init(config: Config) {
  // Guard against a snippet injected twice (some tag managers do this) — the
  // first mount owns window.crumb; later calls would double the launcher.
  if (window.crumb?.__mounted) return;

  // The widget's language: data-locale, else the page's, else the browser's.
  const lc = pickLocale([config.locale, document.documentElement.lang, navigator.language]);
  t = lc.t;
  const when = timeFormat(lc.locale);

  // host element
  const host = document.createElement("div");
  host.id = "crumb-widget";
  // `crumb-block` is the opt-out class the recorder bundle reads — keeps
  // the widget out of any session recording it's about to start, so we
  // don't end up with recursive UI playback inside the player.
  host.className = "crumb-block";
  // Screen readers speak the widget in its own language, which can differ
  // from the page around it (an English widget on a German page).
  host.lang = lc.locale;
  host.style.cssText = "position: fixed; inset: auto 0 0 auto; pointer-events: none; z-index: 2147483647;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);

  // launcher — the "edge whisper" tab: a slim flat tab docked to a viewport
  // edge. Nearly invisible at rest; earns an ember dot (plus a hair of width)
  // when there's loop news, and a small flag with the latest event slides out
  // on hover/focus. It reveals immediately using branding cached from a prior
  // visit (or the right-edge default on first-ever load), then refreshes in
  // place when /me resolves — first paint never waits on the round-trip.
  host.setAttribute("data-edge", "right"); // safe default before cache/me apply
  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.dataset.state = "rest";
  // Name: "Feedback" plus the unread count (render() keeps it current). The
  // flag's event text ("Maya replied") is its description.
  launcher.setAttribute("aria-label", launcherLabel(0));
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "crumb-panel");
  launcher.setAttribute("aria-describedby", "crumb-flag");
  launcher.style.pointerEvents = "none";
  launcher.style.opacity = "0";
  launcher.innerHTML = `
    <span class="l-mark">${LOOP_LAUNCHER}</span>
    <span class="l-label">${t.feedback}</span>
    <span class="l-dot" hidden></span>
    <span class="l-flag" aria-hidden="true"><span class="l-flag-text" id="crumb-flag"></span><span class="l-flag-count"></span></span>`;
  shadow.appendChild(launcher);
  const flagTextEl = launcher.querySelector(".l-flag-text") as HTMLSpanElement;
  const flagCountEl = launcher.querySelector(".l-flag-count") as HTMLSpanElement;
  const newsDotEl = launcher.querySelector(".l-dot") as HTMLSpanElement;

  // One polite live region for everything worth hearing: sends, errors, loop
  // news. It sits outside the panel, so re-renders don't reset it and it can
  // speak while the panel is closed.
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  shadow.appendChild(live);
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  function say(msg: string) {
    live.textContent = "";
    clearTimeout(liveTimer);
    // A beat after clearing, so the same words twice are still read twice.
    liveTimer = setTimeout(() => { live.textContent = msg; }, 100);
  }

  const reducedMotion = (typeof window !== "undefined")
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Touch screens: never focus a text box the customer didn't tap. The
  // keyboard would pop up over the thread they came to read.
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;

  // Vertical nudge along the edge (workspace setting or per-embed
  // data-offset), composed onto a host CSS var that both the launcher and
  // panel read, so they move together.
  let cfgOffsetY = config.offsetY ?? 0;
  function applyOffsets() {
    host.style.setProperty("--crumb-offset-y", `${cfgOffsetY}px`);
  }

  // Effective launcher visibility: a per-embed data-launcher override always
  // wins over the workspace setting (so one page can hide the tab while
  // others keep it). Defaults to "auto" (= shown).
  let brandVisibility: LauncherVisibility = "auto";
  // No customer yet (the script ran before login, or after shutdown()):
  // nothing to show until identify().
  function identified(): boolean { return !!(config.jwt || config.userEmail); }
  function launcherHidden(): boolean {
    return !identified() || (config.launcherOverride ?? brandVisibility) === "hidden";
  }
  function applyVisibility() {
    launcher.style.display = launcherHidden() ? "none" : "";
  }

  // Host hooks for the loop-news signal — lets a site that hid crumb's
  // launcher badge their own. Notified from render() when the count changes.
  const unreadListeners: Array<(n: number) => void> = [];
  let lastUnread = -1;
  function notifyUnread(count: number) {
    if (count === lastUnread) return;
    lastUnread = count;
    for (const cb of unreadListeners) { try { cb(count); } catch { /* host cb */ } }
  }

  function applyBranding(opts: {
    dot?: string | null;
    bg?: string | null;
    edge?: string | null;
    visibility?: LauncherVisibility | null;
    offsetY?: number | null;
  }) {
    if (opts.dot) {
      launcher.style.setProperty("--crumb-accent", opts.dot);
      // Inside the panel the accent fills the primary button and draws the
      // focus ring, unless white on it would fail 4.5:1 (then the panel's ink).
      const brand = readableAccent(opts.dot);
      panel.classList.toggle("branded", !!brand); // hover darkens it a step
      if (brand) {
        panel.style.setProperty("--c-brand", brand);
        panel.style.setProperty("--c-brand-soft", `${brand}24`); // 14% alpha
      } else {
        panel.style.removeProperty("--c-brand");
        panel.style.removeProperty("--c-brand-soft");
      }
    }
    if (opts.bg)  launcher.style.setProperty("--crumb-launcher-bg", opts.bg);
    if (opts.edge === "right" || opts.edge === "left") {
      host.setAttribute("data-edge", opts.edge);
    }
    // Offset: only the workspace/cache value flows through here; a per-embed
    // data-offset (config.offsetY) is already baked into cfgOffsetY. Don't
    // let a null/absent server value clobber an explicit per-embed offset.
    if (config.offsetY == null && opts.offsetY != null) cfgOffsetY = opts.offsetY;
    applyOffsets();
    if (opts.visibility) brandVisibility = opts.visibility;
    applyVisibility();
  }

  function settleLauncher(opts: {
    dot?: string | null;
    bg?: string | null;
    edge?: string | null;
    visibility?: LauncherVisibility | null;
    offsetY?: number | null;
  }) {
    applyBranding(opts);

    // Launcher hidden (host drives crumb via window.crumb.open()) — nothing to
    // reveal. The panel still works; we just never paint the tab.
    if (launcherHidden()) return;

    // Reveal with a single quiet fade — the whisper tab doesn't announce
    // itself. (Instant under prefers-reduced-motion.)
    launcher.style.transition = reducedMotion ? "none" : "opacity 200ms cubic-bezier(0.25, 1, 0.5, 1)";
    launcher.style.opacity = "1";
    launcher.style.pointerEvents = "auto";
  }

  // scrim (only visible when expanded). Pointer-events live in CSS — the
  // closed panel/scrim must stay click-through (an inline `auto` here would
  // beat the stylesheet and leave an invisible hit-target over the host page,
  // swallowing the launcher's hover now that both sit mid-edge).
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  shadow.appendChild(scrim);

  // panel: a modal dialog named by its header title (each view's own).
  // render() makes it inert while closed and moves focus in and back out.
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.id = "crumb-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "crumb-title");
  shadow.appendChild(panel);

  // state
  let open = false;
  let expanded = false;
  let items: ItemSummary[] | null = null; // null = not yet loaded
  // Pending attachments for one composer: "compose" or a thread's short id
  // (attachFor). Cleared when another composer opens or on a successful send.
  let pendingAttachments: ThreadAttachment[] = [];
  let attachFor = "";
  let uploadingAttachment = false;
  let attachmentError: string | null = null;
  // The browser can capture a screen, window or tab (desktop, https, and not
  // blocked by the host page's display-capture policy).
  const canCapture = typeof navigator.mediaDevices?.getDisplayMedia === "function"
    && (document as Document & { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy?.allowsFeature("display-capture") !== false;
  // The host app's build: data-app-version, or crumb.setContext().
  let appVersion = config.appVersion ?? "";
  let listState: AsyncState = { kind: "idle" };
  let view: View = { kind: "list" };
  let thread: ThreadData | null = null;
  let threadState: AsyncState = { kind: "idle" };
  let roadmap: RoadmapData | null = null;
  let roadmapState: AsyncState = { kind: "idle" };
  // One lane of the loaded roadmap (none before it loads).
  const laneOf = (k: Lane): RoadmapEntry[] => roadmap?.columns[k] ?? [];
  // What's new: loaded on the first open; its tab shows once it has entries.
  let news: NewsEntry[] | null = null;
  let newsState: AsyncState = { kind: "idle" };
  // Live fuzzy-search query for the "Your feedback" list. Persists while the
  // panel is open; reset when navigating away from the list (see handlers).
  let searchQuery = "";
  let submitState: AsyncState = { kind: "idle" };
  // Customer-close ("resolve") of the open thread. closeConfirm gates a one-tap
  // confirm so a stray click can't close a request; both reset on thread load.
  let closeState: AsyncState = { kind: "idle" };
  let closeConfirm = false;
  let me: Me | null = null;
  let meState: AsyncState = { kind: "idle" };
  let memberMsg: string | null = null;
  let channelMsg: string | null = null;
  // The account's Slack/Teams channels as the server reports them (masked).
  let channels: Record<"slack" | "teams", { connected: boolean; masked_url: string | null }> | null = null;
  let channelsState: AsyncState = { kind: "idle" };
  // A removal waiting on its inline confirm: a member id, "slack" or "teams".
  let askRemove: string | null = null;
  // A Follow that failed and was rolled back; cleared on the next try or view.
  let followMsg: string | null = null;
  // Identity generation: bumped whenever the customer changes, so a response
  // still in flight for the previous one is dropped (see call()).
  let epoch = 0;
  // crumb_open deep link that arrived before anyone was signed in.
  let pendingOpen: string | null = null;
  // The token the API last reported expired, so onTokenExpired fires once per token.
  let expiredJwt: string | undefined;
  const expiredListeners: Array<() => void> = [];
  // Where the next render() puts focus: true = the view's first sensible
  // control, a selector = that control. False = keep it where it is.
  let moveFocus: boolean | string = false;
  // What had focus when the panel opened (a host button), to return it on close.
  let opener: HTMLElement | null = null;
  let lastSaid = "";  // [data-live] text already announced
  let prevNews = -1;  // unread count at the last render; -1 = list not loaded

  // Every navigation moves focus to the new view; `focus` names a control
  // (a selector) or opts out (false) when the view only changes in place.
  const setView = (v: View, focus: boolean | string = true) => {
    // Leaving the feedback list drops any active search so a return starts clean.
    if (v.kind !== "list") {
      searchQuery = "";
      if (view.kind === "list") markAllStatusesSeen();
    }
    if (view.kind === "news" && v.kind !== "news") markNewsSeen();
    // Files belong to the composer they were attached in.
    const box = v.kind === "compose" ? "compose" : v.kind === "thread" ? v.shortId : attachFor;
    if (box !== attachFor) { attachFor = box; pendingAttachments = []; attachmentError = null; }
    followMsg = null;
    askRemove = null;
    view = v;
    moveFocus = focus;
    render();
  };

  // ── branding cache (instant first paint) ──────────────────
  // Persist /me branding so repeat visits paint the launcher with the correct
  // colors/position immediately — no waiting on the /me round-trip.
  type CachedBrand = { accent?: string; launcher_bg?: string; launcher_edge?: string; launcher_visibility?: LauncherVisibility; launcher_offset_y?: number };
  function brandKey(): string { return `crumb_brand:${config.workspace}`; }
  function readCachedBrand(): CachedBrand | null {
    try { return JSON.parse(localStorage.getItem(brandKey()) || "null"); } catch { return null; }
  }
  function writeCachedBrand(b: CachedBrand): void {
    try { localStorage.setItem(brandKey(), JSON.stringify(b)); } catch { /* storage blocked */ }
  }

  // ── unread watermark (vendor → customer reply signal) ──────
  // localStorage map { short_id: vendor replies seen } per workspace+user. An
  // item is "unread" when its vendor_reply_count grew since the customer last
  // opened its thread, so their own messages (the request body, a reply, an
  // email) never light it. Drives the launcher badge and the row dots so a
  // reply is visible on next page load without reopening every thread.
  // Best-effort: blocked storage (incognito) means {} and every vendor reply
  // reads as new. ponytail: per device; a server-side read mark if customers
  // move between devices a lot. (crumb_seen: held total message counts.)
  function seenKey(): string {
    return `crumb_seen_vendor:${config.workspace}:${userKey()}`;
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
  // Record the vendor replies seen for a thread. Pass the freshly-loaded
  // thread's count, not the (possibly-unloaded) list's, so deep-link and boot
  // opens clear the badge correctly.
  function markThreadSeen(shortId: string, count: number) {
    const m = getSeen();
    m[shortId] = count;
    try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch { /* storage blocked — cache still updated */ }
  }

  // ── status watermark (loop-progress signal) ────────────────
  // localStorage map { short_id: status } per workspace+user. An item carries
  // status news when its status moved to a customer-meaningful one (planned/
  // progress/shipped/declined) since the customer last saw it — so a shipped
  // outcome lights the launcher even when no reply was written. Same
  // best-effort storage posture as the reply watermark above.
  function statusSeenKey(): string {
    return `crumb_status_seen:${config.workspace}:${userKey()}`;
  }
  let statusSeenCache: Record<string, string> | null = null;
  function getStatusSeen(): Record<string, string> {
    if (statusSeenCache) return statusSeenCache;
    let m: Record<string, string>;
    try { m = JSON.parse(localStorage.getItem(statusSeenKey()) || "{}") || {}; } catch { m = {}; }
    statusSeenCache = m;
    return m;
  }
  function writeStatusSeen(m: Record<string, string>) {
    try { localStorage.setItem(statusSeenKey(), JSON.stringify(m)); } catch { /* storage blocked — cache still updated */ }
  }
  function markStatusSeen(shortId: string, status: string) {
    const m = getStatusSeen();
    m[shortId] = status;
    writeStatusSeen(m);
  }
  const newsOf = (it: ItemSummary) => itemNews(it, getSeen()[it.short_id], getStatusSeen()[it.short_id]);
  // The list shows every item's status pill, so leaving it counts as "seen"
  // for all of them (setView, closeApi). Not on render: the rows keep their
  // news dots while the customer is looking.
  function markAllStatusesSeen() {
    if (!items) return;
    const m = getStatusSeen();
    for (const it of items) m[it.short_id] = it.status;
    writeStatusSeen(m);
  }

  // ── What's new watermark ───────────────────────────────────
  // The newest changelog date the customer has seen, per workspace + user;
  // entries published after it light the tab. Set when they leave the tab, so
  // the dots stay while they read. Same best-effort storage as the marks above.
  function newsSeenKey(): string {
    return `crumb_news_seen:${config.workspace}:${userKey()}`;
  }
  function newsSeenAt(): string | null {
    try { return localStorage.getItem(newsSeenKey()); } catch { return null; }
  }
  function markNewsSeen() {
    const newest = news?.[0]?.published_at; // the API lists newest first
    if (!newest) return;
    try { localStorage.setItem(newsSeenKey(), newest); } catch { /* storage blocked */ }
  }

  // Carry the marks over from the keys before these, once, so an update
  // doesn't light every thread already read. A customer with the old reply
  // map is a returning one: seed theirs (marks already on the new key, from a
  // thread opened before the list loaded, win). Status marks filed every token
  // customer under ":jwt". New customers have neither and start empty.
  function adoptLegacyMarks(list: ItemSummary[]) {
    const oldSeen = `crumb_seen:${config.workspace}:${config.userEmail || "jwt"}`;
    const oldStatus = `crumb_status_seen:${config.workspace}:jwt`;
    try {
      if (localStorage.getItem(oldSeen) !== null) {
        seenCache = { ...seedSeen(list), ...getSeen() };
        localStorage.setItem(seenKey(), JSON.stringify(seenCache));
        localStorage.removeItem(oldSeen);
      }
      const statuses = config.jwt ? JSON.parse(localStorage.getItem(oldStatus) || "null") : null;
      if (statuses) {
        statusSeenCache = { ...statuses, ...getStatusSeen() };
        localStorage.setItem(statusSeenKey(), JSON.stringify(statusSeenCache));
        localStorage.removeItem(oldStatus);
      }
    } catch { /* storage blocked or unreadable: nothing to carry */ }
  }

  // ── drafts (outlive a reload, an expired session, a Back tap) ──
  // sessionStorage per workspace + customer: the compose form and each reply
  // box, until that send succeeds. A sign-out or user switch drops them.
  type Drafts = { compose?: { type: ItemType; title: string; body: string }; replies?: Record<string, string> };
  function userKey(): string { return config.jwt ? jwtSub(config.jwt) : config.userEmail; }
  function hasRecordConsent(): boolean { return recordChoice(userKey()) === "on"; }
  function draftKey(): string { return `crumb_draft:${config.workspace}:${userKey()}`; }
  function readDrafts(): Drafts {
    try { return JSON.parse(sessionStorage.getItem(draftKey()) || "{}") || {}; } catch { return {}; }
  }
  function editDrafts(fn: (d: Drafts) => void): void {
    const d = readDrafts();
    fn(d);
    try { sessionStorage.setItem(draftKey(), JSON.stringify(d)); } catch { /* storage blocked: the draft lives in memory only */ }
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

  // One door for every API call: identity on the wire, JSON back, and on
  // failure an Error whose message is customer copy (`code` keeps the raw one).
  type ApiError = Error & { code?: string };
  async function call(path: string, method = "GET", body?: string | FormData): Promise<any> {
    const gen = epoch;
    const jwt = config.jwt;
    const u = new URL(`${config.apiBase}/api/v1/${path}`);
    if (method === "GET") withAuthParams(u);
    const headers = authHeaders();
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    let res: Response | undefined;
    let data: any = {};
    try {
      res = await fetch(u.toString(), { method, headers, body });
      data = await res.json().catch(() => ({}));
    } catch { /* offline, DNS, CORS: no response at all */ }
    // The customer changed mid-flight: never settle, so the last customer's
    // data (or error) can't paint the new one's panel. ponytail: the caller's
    // `finally` never runs either, so forgetUser() resets that state itself;
    // an AbortController per identity if a caller ever needs cleanup.
    if (gen !== epoch) return new Promise(() => {});
    if (res?.ok) return data;
    const code = !res ? "network" : typeof data?.error === "string" ? data.error : "";
    if (code === "jwt_expired" && jwt) tokenExpired(jwt);
    throw Object.assign(new Error(friendlyError(code, res?.status)), { code });
  }

  // Error state for a failed call. Anything that isn't an API error (a bug)
  // still gets plain copy.
  function failed(err: unknown): Extract<AsyncState, { kind: "error" }> {
    const code = (err as ApiError)?.code;
    return { kind: "error", code, message: code === undefined ? friendlyError("") : (err as Error).message };
  }

  function tokenExpired(jwt: string) {
    // A late answer for an older token, or the host already heard about this one.
    if (jwt !== config.jwt || expiredJwt === jwt) return;
    expiredJwt = jwt;
    for (const cb of expiredListeners) { try { cb(); } catch { /* host cb */ } }
  }

  // The replay session to link: the one this tab started on this customer's
  // consent, while it stands. Withdrawing consent (or signing out) forgets the
  // token, so the next session, or customer, never inherits a recording.
  function replayToken(): string | undefined {
    const token = window.__crumbRecord__?.getSessionToken?.();
    return token && hasRecordConsent() && token === storedSessionToken() ? token : undefined;
  }

  // Session record, once /me says this workspace records: until the customer
  // consents the recorder keeps the last two minutes in this tab's memory
  // only; consent sends those and records on under this tab's session.
  function syncRecorder() {
    const rec = window.__crumbRecord__;
    if (!rec || !me?.workspace.session_record_enabled) return;
    const opts = { apiBase: config.apiBase, workspaceSlug: config.workspace, captureBodies: config.recordNetworkBodies };
    const choice = recordChoice(userKey());
    if (choice === "on") rec.start({ ...opts, sessionToken: getOrCreateSessionToken() });
    // They said no: nothing is kept, not even in memory, until they tick again.
    else if (choice === "off") { try { rec.stop(); } catch { /* ignore */ } }
    else rec.buffer?.(opts);
  }

  // ── usage events (crumb.track) ─────────────────────────────
  // Buffered and flushed in batches — same philosophy as the recorder's chunk
  // flushing (timer + on unload). Dropped past a cap so a chatty host can't
  // grow memory unbounded; no-ops until /me confirms tracking is enabled.
  type QueuedEvent = { name: string; props: Record<string, unknown>; ts: string; page_url: string };
  const USAGE_MAX_BUFFER = 100; // hard cap on buffered events
  const USAGE_BATCH = 25;       // flush at this many…
  const USAGE_FLUSH_MS = 5000;  // …or this often
  let usageBuffer: QueuedEvent[] = [];
  let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function track(name: string, props?: Record<string, unknown>) {
    if (typeof name !== "string" || !name) return;
    const ev: QueuedEvent = {
      name: name.slice(0, 64),
      props: props && typeof props === "object" && !Array.isArray(props) ? props : {},
      ts: new Date().toISOString(),
      page_url: redactUrl(location.href),
    };
    if (usageBuffer.length >= USAGE_MAX_BUFFER) usageBuffer.shift(); // drop oldest
    usageBuffer.push(ev);
    if (usageBuffer.length >= USAGE_BATCH) flushUsage();
    else if (!usageFlushTimer) usageFlushTimer = setTimeout(flushUsage, USAGE_FLUSH_MS);
  }

  function flushUsage() {
    if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
    if (!usageBuffer.length) return;
    if (!me?.workspace.usage_tracking_enabled) {
      // /me still loading → keep waiting; resolved-and-off → drop so the
      // buffer can't accumulate forever.
      if (meState.kind === "loading") usageFlushTimer = setTimeout(flushUsage, USAGE_FLUSH_MS);
      else usageBuffer = [];
      return;
    }
    const batch = usageBuffer;
    usageBuffer = [];
    // Tie to a replay session only when one exists (recorder running) — mirrors
    // how submitNew links the session token. Null otherwise.
    const body = authBody({ events: batch, session_token: replayToken() });
    try {
      // keepalive so an unload-time flush still lands.
      fetch(`${config.apiBase}/api/v1/usage-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body,
        keepalive: true,
      }).catch(() => { /* best-effort */ });
    } catch { /* ignore */ }
  }

  async function fetchList() {
    listState = { kind: "loading" };
    render();
    try {
      items = (await call("items")).items as ItemSummary[];
      adoptLegacyMarks(items);
      listState = { kind: "idle" };
    } catch (err) {
      // Trusted-email installs (no JWT) create the customer on their first
      // submission, so until then the list is empty, not a sign-in failure.
      if (!config.jwt && (err as ApiError).code === "user_not_found") {
        items = [];
        listState = { kind: "idle" };
      } else {
        listState = failed(err);
      }
    }
    render();
  }

  async function fetchMe() {
    meState = { kind: "loading" };
    render();
    try {
      me = await call("me") as Me;
      meState = { kind: "idle" };
      // Refresh the launcher's colors/edge in place (revealing it if a stale
      // cache had it hidden), and cache them so the next visit paints them
      // before /me answers.
      const w = me.workspace;
      settleLauncher({
        dot: w.accent ?? null,
        bg: w.launcher_bg ?? null,
        edge: w.launcher_edge ?? null,
        visibility: w.launcher_visibility ?? null,
        offsetY: w.launcher_offset_y ?? null,
      });
      writeCachedBrand({
        accent: w.accent,
        launcher_bg: w.launcher_bg,
        launcher_edge: w.launcher_edge,
        launcher_visibility: w.launcher_visibility,
        launcher_offset_y: w.launcher_offset_y,
      });
      // The recorder loads now, so the minutes before a customer reports a
      // bug are there to send if they consent. Nothing leaves the page until
      // they tick the box in the compose form (or did earlier this tab).
      if (w.session_record_enabled) loadRecorder(config.apiBase, syncRecorder);
    } catch (err) {
      meState = failed(err);
    }
    render();
  }

  async function fetchThread(shortId: string) {
    threadState = { kind: "loading" };
    thread = null;
    // Fresh thread → drop any close prompt/error left over from another item.
    closeConfirm = false;
    closeState = { kind: "idle" };
    render();
    try {
      thread = await call(`items/${encodeURIComponent(shortId)}`) as ThreadData;
      threadState = { kind: "idle" };
      // Viewing the thread clears its unread state: snapshot its vendor
      // replies (the list's vendor_reply_count units) so the launcher badge
      // drops this item, even on a deep-link open before the list loads.
      markThreadSeen(shortId, (thread.messages ?? []).filter(m => m.kind === "vendor").length);
      // The thread shows its status too — clears this item's status news.
      if (thread.item?.status) markStatusSeen(shortId, thread.item.status);
    } catch (err) {
      // A slow failure for a thread the customer already left can't cover the one they're on.
      if (view.kind !== "thread" || view.shortId === shortId) threadState = failed(err);
    }
    render();
  }

  async function fetchRoadmap() {
    roadmapState = { kind: "loading" };
    render();
    try {
      roadmap = await call("roadmap") as RoadmapData;
      roadmapState = { kind: "idle" };
    } catch (err) {
      roadmapState = failed(err);
    }
    render();
  }

  async function fetchNews() {
    newsState = { kind: "loading" };
    try {
      news = (await call("changelog")).entries as NewsEntry[];
      newsState = { kind: "idle" };
    } catch (err) {
      newsState = failed(err); // no tab; the next open tries again
    }
    render();
  }

  async function toggleFollow(initiativeId: string, follow: boolean) {
    const flip = (on: boolean) => {
      for (const k of LANES) {
        const e = laneOf(k).find(x => x.id === initiativeId);
        if (e) e.following = on;
      }
    };
    // Optimistic, and rolled back with a plain why when the server says no.
    followMsg = null;
    flip(follow);
    render();
    try {
      await call("roadmap", "POST", authBody({ initiative_id: initiativeId, follow }));
    } catch (err) {
      flip(!follow);
      followMsg = failed(err).message;
      render();
    }
  }

  // ── customer notification prefs ──
  async function saveNotif(patch: Partial<NotifPrefs>) {
    if (!me) return;
    if (!me.notifications) me.notifications = { replies: true, status: true, roadmap: true, unsubscribed_all: false };
    Object.assign(me.notifications, patch); // optimistic
    render();
    try {
      await call("notifications", "POST", authBody(patch));
    } catch {
      void fetchMe(); // fall back to server truth
    }
  }

  // ── customer chat channel (account admins) ──
  // A Slack/Teams channel incoming webhook on the account, so vendor replies,
  // status changes and roadmap updates also land in the customer's own
  // workspace. The server lists them masked (host/…last4), never the secret.
  // JWT installs only: the endpoint has no trusted-email fallback.
  const CHANNEL_LABEL = { slack: "Slack", teams: "Teams" } as const;
  function channelError(err: unknown): string {
    const code = (err as ApiError).code;
    return code === "invalid_url" ? t.errWebhook
      : code === "forbidden" ? t.errAdminOnly
      : failed(err).message;
  }

  async function fetchChannels() {
    channelsState = { kind: "loading" };
    render();
    try {
      channels = await call("account/integrations/webhook");
      channelsState = { kind: "idle" };
    } catch (err) {
      channelsState = failed(err);
    }
    render();
  }

  // Reads the inputs (shown only for channels not yet connected) on submit.
  async function saveChannels() {
    const urls = (["slack", "teams"] as const)
      .map(p => [p, panel.querySelector<HTMLInputElement>(`input[data-act="${p}-webhook"]`)?.value.trim() ?? ""] as const)
      .filter(([, url]) => url);
    if (!urls.length) { channelMsg = t.pasteWebhook; render(); return; }
    channelMsg = t.channelSaved;
    for (const [provider, url] of urls) {
      try {
        await call("account/integrations/webhook", "POST", authBody({ provider, url }));
      } catch (err) {
        channelMsg = channelError(err);
      }
    }
    await fetchChannels();
  }

  async function removeChannel(provider: "slack" | "teams") {
    try {
      await call(`account/integrations/webhook?provider=${provider}`, "DELETE");
      channelMsg = t.channelRemoved(CHANNEL_LABEL[provider]);
    } catch (err) {
      channelMsg = channelError(err);
    }
    await fetchChannels();
  }

  // ── account member management (admins) ──
  async function setMemberRole(id: string, role: "admin" | "member") {
    if (!me) return;
    memberMsg = null;
    const m = me.members.find(x => x.id === id);
    const prev = m?.role;
    if (m) { m.role = role; render(); }
    try {
      await call("members", "PATCH", authBody({ target_user_id: id, role }));
    } catch (err) {
      if (m && prev) m.role = prev;
      memberMsg = (err as ApiError).code === "last_admin" ? t.errLastAdmin : t.errRole;
      render();
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
      await call("members", "DELETE", authBody({ target_user_id: id }));
      say(t.removed(removed.name));
    } catch (err) {
      const code = (err as ApiError).code;
      me.members.splice(idx, 0, removed);
      me.account.member_count += 1;
      memberMsg = code === "has_items" ? t.errHasItems : code === "last_admin" ? t.errLastAdmin : t.errRemove;
      render();
    }
  }

  // Where the customer was when they wrote in, so the vendor never has to ask
  // (shown in the thread's Details card). Secrets come out of the URLs here
  // and again on the server.
  function submissionContext() {
    return {
      page_url: redactUrl(location.href),
      page_title: document.title || undefined,
      referrer: document.referrer ? redactUrl(document.referrer) : undefined,
      user_agent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      locale: navigator.language,
      app_version: appVersion || undefined,
    };
  }

  async function submitNew(v: Extract<View, { kind: "compose" }>) {
    if (submitState.kind === "loading" || uploadingAttachment) return; // a second Cmd+Enter mid-send
    if (!v.title.trim()) {
      submitState = { kind: "error", message: friendlyError("missing_title") };
      render();
      return;
    }
    submitState = { kind: "loading" };
    render();
    const gen = epoch;
    try {
      // With a recording on, what it holds goes up first (a few seconds at
      // most), and its token rides along to link it; chunks that land later
      // join it. Files ride on the first message.
      if (replayToken()) await Promise.race([window.__crumbRecord__?.flush?.(), new Promise(r => setTimeout(r, 3000))]);
      if (gen !== epoch) return; // the customer changed while it sent: forgetUser reset the form
      const data = await call("items", "POST", authBody({ type: v.type, title: v.title.trim(), body: v.body.trim(), session_token: replayToken(), context: submissionContext(), attachment_ids: pendingAttachments.map(a => a.id) }));
      const sid: string = data.short_id;
      pendingAttachments = [];
      attachmentError = null;
      editDrafts(d => { delete d.compose; });
      // Their own new request is not news to them.
      markThreadSeen(sid, 0);
      markStatusSeen(sid, "open");
      // Swap the form out before Send re-enables, so a second click can't
      // post the same request again; the list refreshes behind the confirm.
      submitState = { kind: "idle" };
      setView({ kind: "confirm", shortId: sid });
      void fetchList();
    } catch (err) {
      submitState = failed(err);
      render();
    }
  }

  async function submitReply(v: Extract<View, { kind: "thread" }>) {
    if (submitState.kind === "loading" || uploadingAttachment) return;
    if (!v.reply.trim() && pendingAttachments.length === 0) return;
    submitState = { kind: "loading" };
    render();
    try {
      const attachmentIds = pendingAttachments.map(a => a.id);
      await call(`items/${encodeURIComponent(v.shortId)}`, "POST", authBody({ body: v.reply.trim(), attachment_ids: attachmentIds }));
      submitState = { kind: "idle" };
      pendingAttachments = [];
      attachmentError = null;
      editDrafts(d => { if (d.replies) delete d.replies[v.shortId]; });
      view = { kind: "thread", shortId: v.shortId, reply: "" };
      say(t.replySent);
      await fetchThread(v.shortId);
    } catch (err) {
      submitState = failed(err);
      render();
    }
  }

  // Close ("resolve") the open request. The customer is telling us they're all
  // set; the server flips the item to "resolved" and notifies the vendor. We
  // refetch so the thread reflects the closed loop (and the affordance hides).
  async function closeRequest(v: Extract<View, { kind: "thread" }>) {
    closeConfirm = false;
    closeState = { kind: "loading" };
    render();
    try {
      await call(`items/${encodeURIComponent(v.shortId)}/close`, "POST", authBody({}));
      closeState = { kind: "idle" };
      say(t.requestClosed);
      await fetchThread(v.shortId);
    } catch (err) {
      closeState = failed(err);
      render();
    }
  }

  // One upload path (and the server's limits) for every composer's files.
  async function uploadFile(file: File) {
    const box = attachFor;
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
        // A first-time customer has no row yet: these let the server create
        // it, as POST /items does, so compose can attach before the first send.
        if (config.accountName) form.append("account_name", config.accountName);
        if (config.userName) form.append("account_user_name", config.userName);
      }
      const data = await call("uploads", "POST", form);
      // The customer may have moved to another composer while it uploaded.
      if (attachFor === box) {
        pendingAttachments.push({
          id: data.id,
          filename: data.filename,
          content_type: data.content_type,
          size_bytes: data.size_bytes,
        });
        say(t.attached(data.filename));
      }
    } catch (err) {
      attachmentError = failed(err).message;
    } finally {
      uploadingAttachment = false;
      render();
    }
  }

  function pickAndUploadAttachment() {
    if (uploadingAttachment) return;
    attachmentError = null;
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.onchange = () => { const file = input.files?.[0]; if (file) void uploadFile(file); };
    input.click();
  }

  // One frame of the screen, window or tab the customer picks, as a PNG. Only
  // ever on their click, and the browser asks what to share every time. The
  // widget steps out of the frame so it doesn't cover what they're showing.
  async function captureScreenshot() {
    if (uploadingAttachment) return;
    attachmentError = null;
    let stream: MediaStream | undefined;
    let shot: Blob | null = null;
    try {
      // Offer this tab first where the browser can (Chrome); others ignore it.
      const opts = { video: true, preferCurrentTab: true, selfBrowserSurface: "include" };
      stream = await navigator.mediaDevices.getDisplayMedia(opts);
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      host.style.opacity = "0";
      await new Promise(r => setTimeout(r, 300)); // a few frames for the capture to catch up
      // Capped at 2560px a side so a 5K screen stays under the upload limit.
      const scale = Math.min(1, 2560 / Math.max(video.videoWidth, video.videoHeight, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      shot = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/png"));
      if (!shot) throw new Error("no frame");
    } catch (err) {
      // Closing the picker isn't a failure worth a message.
      if ((err as Error)?.name !== "NotAllowedError") attachmentError = t.errCapture;
    } finally {
      stream?.getTracks().forEach(t => t.stop());
      host.style.opacity = "";
    }
    if (shot) await uploadFile(new File([shot], "screenshot.png", { type: "image/png" }));
    else render();
  }

  function removePendingAttachment(id: string) {
    pendingAttachments = pendingAttachments.filter(a => a.id !== id);
    render();
  }

  function humanBytes(b: number): string {
    const [B, KB, MB] = t.sizeUnits;
    const n = (v: number, digits: number) => v.toLocaleString(lc.locale, { maximumFractionDigits: digits });
    return b < 1024 ? `${n(b, 0)} ${B}` : b < 1048576 ? `${n(b / 1024, 0)} ${KB}` : `${n(b / 1048576, 1)} ${MB}`;
  }

  // "3 days ago", with the full date and time on hover.
  function timeHtml(iso: string, cls: string): string {
    return `<time class="${cls}" datetime="${escapeHtml(iso)}" title="${escapeHtml(when.exact(iso))}">${escapeHtml(when.ago(iso))}</time>`;
  }

  // ── render ─────────────────────────────────────────────
  function render() {
    const opening = open && !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    panel.classList.toggle("expanded", open && expanded);
    scrim.classList.toggle("show", open && expanded);
    // Closed means gone for keyboards and screen readers too, not just see-through.
    panel.inert = !open;
    if (open) panel.removeAttribute("aria-hidden");
    else panel.setAttribute("aria-hidden", "true");
    launcher.setAttribute("aria-expanded", String(open));

    // Loop news on the launcher: vendor replies the customer hasn't opened
    // plus customer-meaningful status moves (planned/progress/shipped/
    // declined) since they last saw the item. News = the ember dot + the
    // hover flag's event text.
    const newsItems = (items ?? []).filter(it => { const nw = newsOf(it); return nw.reply || nw.status; });
    const n = newsItems.length;
    notifyUnread(n);
    // Phrase the most recent event: "Maya replied" / "Shipped: Dark mode"
    // (the flag's CSS trims a long title; the spoken text keeps it whole).
    let phrase = "";
    if (n) {
      const eventAt = (it: ItemSummary) => new Date(it.last_event?.at ?? it.updated_at).getTime();
      const top = newsItems.reduce((a, b) => (eventAt(b) > eventAt(a) ? b : a));
      phrase = newsPhrase(top, newsOf(top));
    }
    // News that arrived since the last look is read out; what was already
    // waiting at load is in the launcher's name instead.
    if (items && prevNews >= 0 && n > prevNews) say(n > 1 ? `${phrase}. ${t.updates(n)}.` : `${phrase}.`);
    prevNews = items ? n : -1;
    launcher.setAttribute("aria-label", launcherLabel(n));
    const hasNews = n > 0 && !open;
    launcher.dataset.state = hasNews ? "news" : "rest";
    newsDotEl.hidden = !hasNews;
    flagTextEl.textContent = hasNews ? phrase : t.shareFeedback;
    flagCountEl.textContent = hasNews && n > 1 ? `· ${n}` : "";

    if (!open) return;
    if (opening) lastSaid = ""; // reopened: say what's on screen again

    // The rebuild below replaces every control. Note where focus was, to put
    // it back on the same control (and caret) after. Focus the customer put on
    // the host page stays there, except when the panel is just opening.
    const prev = shadow.activeElement as HTMLInputElement | null;
    const inPanel = !!prev && panel.contains(prev);
    const key = inPanel ? controlKey(prev) : "";
    const caret = [prev?.selectionStart ?? 0, prev?.selectionEnd ?? 0] as const;
    const lost = !document.activeElement || document.activeElement === document.body;

    if (view.kind === "list") renderList();
    else if (view.kind === "admin") renderAdmin();
    else if (view.kind === "roadmap") renderRoadmap();
    else if (view.kind === "news") renderNews();
    else if (view.kind === "settings") renderSettings();
    else if (view.kind === "compose") renderCompose(view);
    else if (view.kind === "thread") renderThread(view);
    else if (view.kind === "confirm") renderConfirm(view);

    // Errors and confirmations (marked data-live) are announced once, when they appear.
    // Each part ends in a stop, so a heading and its line read as two sentences.
    const said = Array.from(panel.querySelectorAll("[data-live]"), el => (el.textContent ?? "").trim())
      .filter(Boolean).map(s => /[.!?…]$/.test(s) ? s : `${s}.`).join(" ");
    if (said !== lastSaid) { lastSaid = said; if (said) say(said); }

    const want = moveFocus;
    moveFocus = false;
    if (want ? opening || inPanel || lost : inPanel) {
      const same = want || !key ? undefined
        : Array.from(panel.querySelectorAll<HTMLInputElement>("[data-act], [id]")).find(el => controlKey(el) === key);
      if (same && !same.disabled) {
        same.focus();
        try { same.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
      } else {
        focusView(typeof want === "string" ? want : undefined);
      }
    }
  }

  // The view's first sensible control: a named one, else the text box where
  // typing is the point (the reply box only off touch screens), else the
  // selected tab or first button, so focus never falls out of the dialog.
  function focusView(sel?: string) {
    const q = (s: string) => panel.querySelector<HTMLElement>(s);
    const el = (sel && q(sel))
      || (view.kind === "compose" && q('[data-act="title"]'))
      || (view.kind === "thread" && q(coarse ? '[data-act="back"]' : '[data-act="reply"]'))
      || q('.body button:not(:disabled):not([tabindex="-1"]), .foot button:not(:disabled)')
      || q('[data-act="close"]');
    el?.focus();
  }

  // Tab and Shift+Tab cycle inside the open panel (it's aria-modal). Focus
  // the customer clicked out onto the host page is theirs; only focus in the
  // panel, or dropped to <body>, is held.
  function trapTab(e: KeyboardEvent) {
    const a = shadow.activeElement as HTMLElement | null;
    if (a ? !panel.contains(a) : document.activeElement !== document.body) return;
    const all = Array.from(panel.querySelectorAll<HTMLButtonElement>("a[href], button, input, textarea, [tabindex]"))
      .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
    // Between two controls (focus may sit on a heading outside the Tab
    // order), the browser's own order is right; past either end, wrap.
    const side = (pos: number) => !!a && all.some(el => a.compareDocumentPosition(el) & pos);
    const to = e.shiftKey ? (side(Node.DOCUMENT_POSITION_PRECEDING) ? null : all[all.length - 1])
      : (side(Node.DOCUMENT_POSITION_FOLLOWING) ? null : all[0]);
    if (to) { e.preventDefault(); to.focus(); }
  }

  // The tab strip and its panel. Arrow keys move between tabs (panel keydown);
  // only the selected tab is in the Tab order.
  function tabbed(active: "feedback" | "roadmap" | "news" | "admin", inner: string): string {
    const tabs: Array<[string, string]> = [["feedback", t.yourFeedback]];
    if (me?.has_roadmap) tabs.push(["roadmap", t.roadmap]);
    if (news?.length) tabs.push(["news", t.whatsNew]);
    if (me?.is_account_admin) tabs.push(["admin", t.admin]);
    // No tabs when there's nothing beyond the feedback list.
    if (tabs.length === 1) return inner;
    // What's new wears a dot while it has entries the customer hasn't seen.
    const seenAt = newsSeenAt();
    const unseen = active === "news" ? 0 : (news ?? []).filter(e => newsUnseen(e, seenAt)).length;
    const dot = unseen ? `<span class="news-dot" aria-hidden="true"></span><span class="sr-only">, ${t.updates(unseen)}</span>` : "";
    return `<div class="tabs" role="tablist">${tabs.map(([k, label]) =>
        `<button class="tab" role="tab" id="crumb-tab-${k}" aria-controls="crumb-tabpanel" aria-selected="${k === active}" tabindex="${k === active ? 0 : -1}" data-act="tab" data-tab="${k}">${label}${k === "news" ? dot : ""}</button>`).join("")}</div>
      <div class="tabpanel" role="tabpanel" id="crumb-tabpanel" aria-labelledby="crumb-tab-${active}">${inner}</div>`;
  }

  function header(title: string, sub?: string, withBack = false, expandable = false): string {
    return `
      <div class="head">
        ${withBack
          ? `<button class="back" aria-label="${t.back}" data-act="back">${ICONS.back}</button>`
          : `<span class="brand-mark">${LOOP_HEAD}</span>`}
        <div class="title"><span id="crumb-title">${escapeHtml(title)}</span>${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>
        ${(!withBack && me?.email_enabled) ? `<button class="close" aria-label="${t.notifSettings}" data-act="open-settings">${ICONS.gear}</button>` : ""}
        ${expandable ? `<button class="close" aria-label="${expanded ? t.collapse : t.expand}" data-act="toggle-expand">${expanded ? ICONS.collapse : ICONS.expand}</button>` : ""}
        <button class="close" aria-label="${t.close}" data-act="close">${ICONS.x}</button>
      </div>`;
  }

  function statusPillHtml(status: Status): string {
    return `<span class="status-pill"><span class="status-dot ${status}"></span>${t.statuses[status]}</span>`;
  }

  // Header subtitle: /me once it answers, the embed's data-* attributes until
  // then (identify() clears those, so a switch never shows the last customer).
  function accountName(): string { return me?.account.name || config.accountName; }

  // A load that failed: plain copy and a way forward. Retrying can't fix a
  // request that isn't theirs (a forwarded link) or that's gone, so those
  // offer the customer's own list instead.
  function errorStateHtml(s: { message: string; code?: string }): string {
    const dead = s.code === "not_your_item" || s.code === "item_not_found";
    return `
      <div class="empty">
        <span class="icon warn">${ICONS.alert}</span>
        <p data-live>${escapeHtml(s.message)}</p>
        ${dead
          ? `<button class="outline" data-act="see-list">${t.seeYourFeedback}</button>`
          : `<button class="outline" data-act="retry">${t.tryAgain}</button>`}
      </div>`;
  }

  // The inline version, when older data is still worth showing below it.
  function errBannerHtml(message: string): string {
    return `<div class="err"><span data-live>${escapeHtml(message)}</span> <button class="err-retry" data-act="retry">${t.tryAgain}</button></div>`;
  }

  function feedbackRowHtml(it: ItemSummary): string {
    // A dot for news, said first: "New reply. FB-12, In progress…"
    const nw = newsOf(it);
    const news = nw.reply ? t.newReply : nw.status ? t.statusUpdate : "";
    return `
      <button class="item-row" data-act="open-thread" data-short="${escapeHtml(it.short_id)}">
        <div class="top">
          ${news ? `<span class="news-dot" aria-hidden="true"></span><span class="sr-only">${news}.</span>` : ""}
          <span class="short">${escapeHtml(it.short_id)}</span>
          ${statusPillHtml(it.status)}
          ${timeHtml(it.updated_at, "age")}
        </div>
        <div class="title">${escapeHtml(it.title)}</div>
        ${it.reply_count > 1 ? `<div class="bottom">${t.replies(it.reply_count - 1)}</div>` : ""}
      </button>`;
  }

  // A public roadmap initiative, on the Roadmap tab and in search results:
  // where it stands, and Follow until it ships (then when it shipped).
  function roadmapCardHtml(e: RoadmapEntry): string {
    const shipped = e.lane === "shipped";
    return `
      <div class="rm-card">
        <div class="rm-card-top">
          <span class="rm-name">${escapeHtml(e.name)}</span>
          ${shipped ? "" : `<button class="rm-follow${e.following ? " on" : ""}" data-act="follow" data-id="${escapeHtml(e.id)}" data-following="${e.following ? "1" : "0"}">${e.following ? t.following : t.follow}</button>`}
        </div>
        ${e.description ? `<p class="rm-desc">${escapeHtml(e.description)}</p>` : ""}
        <div class="rm-meta">${statusPillHtml(INITIATIVE_STATUS[e.status] ?? "open")}${shipped && e.shipped_at ? timeHtml(e.shipped_at, "rm-when") : ""}</div>
      </div>`;
  }

  // Inner HTML for the live-search results container. Empty query → the full
  // list; otherwise fuzzy-ranked feedback plus any matching public roadmap
  // initiatives. Reads searchQuery/items/roadmap from closure state so the
  // input handler can re-render just this container (preserving input focus).
  function buildResultsHtml(): string {
    const list = items ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return `<div class="items-list">${list.map(feedbackRowHtml).join("")}</div>`;

    const matched = list
      .map(it => ({ it, s: scoreItem(q, it) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s);

    const rmEntries = ([] as RoadmapEntry[]).concat(...LANES.map(laneOf));
    const rmMatched = rmEntries
      .map(e => ({ e, s: scoreRoadmap(q, e) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s);

    if (matched.length === 0 && rmMatched.length === 0) {
      return `<div class="empty"><p>${t.noMatches(escapeHtml(searchQuery.trim()))}</p></div>`;
    }

    let html = "";
    if (matched.length) html += `<div class="items-list">${matched.map(x => feedbackRowHtml(x.it)).join("")}</div>`;
    if (rmMatched.length) {
      html += `<div class="results-section">
        <div class="results-head">${t.fromRoadmap}</div>
        ${followMsg ? `<div class="err" data-live>${escapeHtml(followMsg)}</div>` : ""}
        <div class="rm-results">${rmMatched.map(x => roadmapCardHtml(x.e)).join("")}</div>
      </div>`;
    }
    return html;
  }

  function renderList() {
    const isLoading = listState.kind === "loading" && items === null;
    let bodyHtml = "";

    if (isLoading) {
      bodyHtml += `<div class="skeleton">${`<div class="skel row"></div>`.repeat(4)}</div>`;
    } else if (listState.kind === "error" && !items) {
      // Never loaded: a failure, not an empty inbox.
      bodyHtml += errorStateHtml(listState);
    } else if (!items || items.length === 0) {
      if (listState.kind === "error") bodyHtml += errBannerHtml(listState.message);
      bodyHtml += `
        <div class="empty">
          <span class="icon">${ICONS.chat}</span>
          <h2>${t.emptyTitle}</h2>
          <p>${t.emptyBody}</p>
          <button class="primary" data-act="new" style="margin-top:8px">
            ${ICONS.plus}<span>${t.shareFeedback}</span>
          </button>
        </div>`;
    } else {
      if (listState.kind === "error") bodyHtml += errBannerHtml(listState.message);
      bodyHtml += `
        <input class="field search-input" data-act="search" type="text" placeholder="${t.searchFeedback}…" aria-label="${t.searchFeedback}" />
        <div class="results" data-results>${buildResultsHtml()}</div>`;
    }

    panel.innerHTML = `
      ${header(t.yourFeedback, accountName())}
      <div class="body">${tabbed("feedback", bodyHtml)}</div>
      <div class="foot">
        <div class="row">
          <span class="meta">${t.viaCrumb}</span>
          <button class="primary" data-act="new">${ICONS.plus}<span>${t.shareFeedback}</span></button>
        </div>
      </div>`;

    // A full re-render (roadmap arrival, follow toggle) rebuilds the input:
    // set its value via property (no HTML-escaping pitfalls); render() puts
    // focus and caret back if it had them. Keystroke updates take the partial
    // path in the input handler and never reach here.
    const searchEl = panel.querySelector<HTMLInputElement>('input[data-act="search"]');
    if (searchEl) searchEl.value = searchQuery;
  }

  function renderAdmin() {
    if (!me) {
      panel.innerHTML = `
        ${header(accountName())}
        <div class="body">${meState.kind === "error"
          ? errorStateHtml(meState)
          : `<div class="skeleton"><div class="skel row"></div><div class="skel row"></div></div>`}</div>`;
      return;
    }

    const isAdmin = me.is_account_admin;
    // A removal asks once, in place: Cancel (focused first) or Remove.
    const askHtml = (id: string, what: string, act: string) => `
      <div class="member-actions" role="group" aria-label="${escapeHtml(t.removeAsk(what))}">
        <button class="member-role" data-act="ask-cancel" data-id="${escapeHtml(id)}">${t.cancel}</button>
        <button class="member-role danger" data-act="${act}" data-id="${escapeHtml(id)}">${t.remove}</button>
      </div>`;
    const membersHtml = me.members.length === 0
      ? `<p class="text-sm muted" style="margin:0">${t.noTeammates}</p>`
      : `<div class="members">${me.members.map(m => {
          const self = m.id === me!.user.id;
          const controls = (isAdmin && !self)
            ? askRemove === m.id ? askHtml(m.id, m.name, "member-remove") : `<div class="member-actions">
                 <button class="member-role" data-act="member-role" data-id="${escapeHtml(m.id)}" data-next="${m.role === "admin" ? "member" : "admin"}" title="${t.changeRole}">${m.role === "admin" ? t.roleAdmin : t.roleMember}</button>
                 <button class="member-remove" data-act="remove-ask" data-id="${escapeHtml(m.id)}" aria-label="${escapeHtml(t.removeName(m.name))}">${ICONS.trash}</button>
               </div>`
            : (m.role === "admin" ? `<span class="role-pill">${t.roleAdmin}</span>` : `<span class="member-count">${m.item_count}</span>`);
          return `<div class="member-row">
            <span class="member-avatar">${escapeHtml(m.initials)}</span>
            <div class="member-meta">
              <span class="member-name">${escapeHtml(m.name)}${self ? ` <span class="member-you">${t.you}</span>` : ""}</span>
              <span class="member-email">${escapeHtml(m.email)}</span>
            </div>
            ${controls}
          </div>`;
        }).join("")}
        </div>`;

    // A connected channel shows masked, with Remove; one that isn't takes a URL.
    const example = { slack: "https://hooks.slack.com/…", teams: "https://…webhook.office.com/…" };
    const channelRow = (p: "slack" | "teams", c: { connected: boolean; masked_url: string | null }) => c.connected ? `
      <div class="channel-row">
        <span class="channel-name">${CHANNEL_LABEL[p]}</span>
        <span class="channel-url">${escapeHtml(c.masked_url ?? t.connected)}</span>
        ${askRemove === p ? askHtml(p, t.channel(CHANNEL_LABEL[p]), "channel-remove")
          : `<button class="member-role" data-act="remove-ask" data-id="${p}" aria-label="${t.removeName(t.channel(CHANNEL_LABEL[p]))}">${t.remove}</button>`}
      </div>`
      : `<input class="field" data-act="${p}-webhook" aria-label="${t.webhookUrl(CHANNEL_LABEL[p])}" placeholder="${t.webhookHint(CHANNEL_LABEL[p], example[p])}" />`;
    let channelsHtml = channelsState.kind === "error" ? errBannerHtml(channelsState.message) : "";
    if (channels) {
      channelsHtml += channelRow("slack", channels.slack) + channelRow("teams", channels.teams);
      if (!channels.slack.connected || !channels.teams.connected) channelsHtml += `<button class="primary" data-act="save-channels">${t.saveChannel}</button>`;
    } else if (channelsState.kind !== "error") {
      channelsHtml += `<div class="skel row"></div>`;
    }

    const count = t.memberCount(me.account.member_count, me.account.name);
    panel.innerHTML = `
      ${header(me.account.name, count)}
      <div class="body">${tabbed("admin", `
        <section class="admin-card">
          <div class="admin-card-head">
            <span class="admin-card-title" id="crumb-members-head" tabindex="-1">${t.members}</span>
            <span class="admin-card-sub">${escapeHtml(count)}</span>
          </div>
          ${memberMsg ? `<div class="err" data-live style="margin-bottom:10px">${escapeHtml(memberMsg)}</div>` : ""}
          ${membersHtml}
          ${isAdmin ? `<p class="set-sub" style="margin:12px 2px 0">${t.membersHelp}</p>` : ""}
        </section>
        ${isAdmin && config.jwt ? `
        <section class="admin-card">
          <div class="admin-card-head">
            <span class="admin-card-title" id="crumb-channels-head" tabindex="-1">${t.notifyChannel}</span>
            <span class="admin-card-sub">Slack / Teams</span>
          </div>
          <p class="set-sub" style="margin:0 2px">${t.channelHelp}</p>
          ${channelMsg ? `<div class="set-sub" data-live style="margin:0 2px">${escapeHtml(channelMsg)}</div>` : ""}
          ${channelsHtml}
        </section>` : ""}`)}
      </div>`;
  }

  function renderSettings() {
    const n: NotifPrefs = me?.notifications ?? { replies: true, status: true, roadmap: true, unsubscribed_all: false };
    const paused = n.unsubscribed_all;
    // Each switch is named by its label and described by its hint.
    const row = (id: string, label: string, sub: string, on: boolean, act: string, off = false) => `
      <div class="set-row${off ? " disabled" : ""}">
        <div class="set-meta"><span class="set-label" id="crumb-${id}">${label}</span><span class="set-sub" id="crumb-${id}-sub">${sub}</span></div>
        <button class="sw${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-labelledby="crumb-${id}" aria-describedby="crumb-${id}-sub" ${act}${off ? " disabled" : ""}></button>
      </div>`;
    const toggleRow = (key: "replies" | "status" | "roadmap", label: string, sub: string) =>
      row(key, label, sub, n[key] && !paused, `data-act="notif-toggle" data-key="${key}"`, paused);
    panel.innerHTML = `
      ${header(t.notifications, accountName(), true)}
      <div class="body">
        <p class="lede" style="margin:0 0 14px">${t.notifLede(escapeHtml(me?.workspace.name ?? ""))}</p>
        ${toggleRow("replies", t.notifReplies, t.notifRepliesHint)}
        ${toggleRow("status", t.notifStatus, t.notifStatusHint)}
        ${toggleRow("roadmap", t.notifRoadmap, t.notifRoadmapHint)}
        <div class="set-divider"></div>
        ${row("pause", t.pauseAll, t.pauseAllHint, paused, 'data-act="notif-pause"')}
      </div>`;
  }

  function renderRoadmap() {
    const isLoading = roadmapState.kind === "loading" && roadmap === null;
    let bodyHtml = "";

    if (isLoading) {
      bodyHtml += `<div class="skeleton"><div class="skel row"></div><div class="skel row"></div></div>`;
    } else if (roadmapState.kind === "error" && !roadmap) {
      bodyHtml += errorStateHtml(roadmapState);
    } else if (roadmap) {
      if (followMsg) bodyHtml += `<div class="err" data-live>${escapeHtml(followMsg)}</div>`;
      const total = LANES.reduce((n, k) => n + laneOf(k).length, 0);
      if (total === 0) {
        bodyHtml += `
          <div class="empty">
            <span class="icon">${ICONS.idea}</span>
            <h2>${t.roadmapEmpty}</h2>
            <p>${t.roadmapEmptyBody}</p>
          </div>`;
      } else {
        // Recently shipped is the last lane: the newest few, newest first.
        bodyHtml += `<div class="rm-board">` + LANES.map(key => {
          const entries = laneOf(key);
          if (entries.length === 0) return "";
          return `
            <div class="rm-col">
              <div class="rm-col-head">${t.columns[key]}</div>
              ${entries.map(roadmapCardHtml).join("")}
            </div>`;
        }).join("") + `</div>`;
      }
    }

    panel.innerHTML = `
      ${header(t.roadmap, accountName())}
      <div class="body">${tabbed("roadmap", bodyHtml)}</div>`;
  }

  // What's new: the team's published changelog, newest first, as plain text.
  // Entries since the customer last looked keep a dot until they leave.
  function renderNews() {
    const seenAt = newsSeenAt();
    const entries = (news ?? []).map(e => `
      <article class="news-entry">
        <div class="news-top">
          ${newsUnseen(e, seenAt) ? `<span class="news-dot" aria-hidden="true"></span><span class="sr-only">${t.newEntry}.</span>` : ""}
          ${e.published_at ? timeHtml(e.published_at, "news-when") : ""}
        </div>
        <h2 class="news-title">${escapeHtml(e.title)}</h2>
        ${e.body.trim() ? `<p class="news-body">${escapeHtml(e.body.trim())}</p>` : ""}
      </article>`).join("");
    panel.innerHTML = `
      ${header(t.whatsNew, accountName())}
      <div class="body">${tabbed("news", `<div class="news-list">${entries}</div>`)}</div>`;
  }

  // Files waiting to go out with the next send, and why the last one didn't.
  function pendingHtml(): string {
    return `${attachmentError ? `<div class="err" data-live>${escapeHtml(attachmentError)}</div>` : ""}
      ${pendingAttachments.length ? `<div class="pending-attachments">${pendingAttachments.map(a => `
        <span class="pending-attachment">
          ${ICONS.attach}
          <span class="filename">${escapeHtml(a.filename)}</span>
          <span class="size">${humanBytes(a.size_bytes)}</span>
          <button data-act="remove-attachment" data-id="${escapeHtml(a.id)}" aria-label="${escapeHtml(t.removeName(a.filename))}">${ICONS.x}</button>
        </span>`).join("")}</div>` : ""}`;
  }

  function renderCompose(v: Extract<View, { kind: "compose" }>) {
    const submitting = submitState.kind === "loading";
    const err = submitState.kind === "error" ? submitState.message : "";
    // Who and which account the request goes in as: /me on JWT installs.
    const who = me?.user.name || config.userName;
    // aria-disabled, not disabled, so focus stays put while a file uploads.
    const busy = uploadingAttachment ? ` aria-disabled="true"` : "";
    panel.innerHTML = `
      ${header(t.shareFeedback, undefined, true)}
      <div class="body">
        <div>
          <span class="field-label" id="crumb-type-label">${t.type}</span>
          <div class="types" role="group" aria-labelledby="crumb-type-label">
            ${TYPES.map(k => `
              <button class="type-btn" data-act="type" data-type="${k}" aria-pressed="${v.type === k}">
                ${ICONS[k]}
                <span>${t.types[k]}</span>
              </button>`).join("")}
          </div>
        </div>

        <label>
          <span class="field-label">${t.title}</span>
          <input class="field" data-act="title" maxlength="${MAX_LEN.title}" placeholder="${t.titleHint}" />
        </label>

        <label>
          <span class="field-label">${t.details}</span>
          <textarea class="field" data-act="body" maxlength="${MAX_LEN.body}" placeholder="${t.detailsHint}"></textarea>
        </label>

        <div class="attach-row">
          <button class="outline" data-act="pick-attachment"${busy}>${ICONS.attach}<span>${t.attachFile}</span></button>
          ${canCapture ? `<button class="outline" data-act="capture"${busy}>${ICONS.screen}<span>${t.capture}</span></button>` : ""}
          ${uploadingAttachment ? `<span class="attach-note">${t.uploading}</span>` : ""}
        </div>
        ${pendingHtml()}

        ${me?.workspace.session_record_enabled ? `
        <label data-act="record-consent-row" style="display:flex;gap:8px;align-items:flex-start;margin-top:2px;cursor:pointer">
          <input type="checkbox" data-act="record-consent" ${hasRecordConsent() ? "checked" : ""} style="margin-top:2px;flex:none" />
          <span style="display:flex;flex-direction:column;gap:2px">
            <span style="font-size:13px;font-weight:600">${t.recordConsent}</span>
            <span style="font-size:11px;color:var(--c-ink-2);line-height:1.45">${config.recordNetworkBodies ? t.recordBodies : t.recordNoBodies} ${t.recordWindow} ${t.recordMasking}</span>
          </span>
        </label>` : ""}

        ${err ? `<div class="err" data-live>${escapeHtml(err)}</div>` : ""}
      </div>
      <div class="foot">
        <div class="row">
          <span class="meta">${escapeHtml(who ? t.postingAs(who, accountName()) : accountName())}</span>
          <button class="primary" data-act="submit" ${submitting || uploadingAttachment ? "disabled" : ""}>
            ${ICONS.send}<span>${submitting ? t.sending : t.send}</span>
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
    let body = "";
    let footMeta = "";

    if (threadState.kind === "error") {
      body = errorStateHtml(threadState);
    } else if (threadState.kind === "loading" || thread === null || thread.item.short_id !== v.shortId) {
      body = `<div class="skeleton"><div class="skel row"></div><div class="skel row" style="height:96px"></div><div class="skel row" style="height:64px"></div></div>`;
    } else {
      const msgs = thread.messages.map(m => {
        // Signed link: a new tab sends no credentials, so the bare path 403s.
        const atts = (m.attachments ?? []).map(a => `
          <a class="attachment" href="${escapeHtml(new URL(a.url ?? `/api/v1/uploads/${a.id}`, config.apiBase).href)}" target="_blank" rel="noreferrer">
            ${ICONS.attach}
            <span class="filename">${escapeHtml(a.filename)}</span>
            <span class="size">${humanBytes(a.size_bytes)}</span>
          </a>`).join("");
        return `
          <div class="msg ${m.kind === "vendor" ? "vendor" : ""}">
            <div class="meta">
              <span class="avatar">${escapeHtml(m.author_initials)}</span>
              <span>${escapeHtml(m.author_name)}</span>
              ${timeHtml(m.created_at, "when")}
            </div>
            ${m.body ? `<p>${escapeHtml(m.body)}</p>` : ""}
            ${atts ? `<div class="attachments">${atts}</div>` : ""}
          </div>`;
      }).join("");

      // Status timeline — visible in the expanded side rail, hidden when collapsed.
      const eventsHtml = thread.events.map(e => {
        const isInitial = e.from_status === null;
        const label = isInitial ? t.submitted : (t.statuses[e.to_status as Status] ?? e.to_status);
        const reasonHtml = e.reason
          ? `<div class="event-reason">${escapeHtml(e.reason)}</div>`
          : "";
        return `<div class="event">
          <span class="event-dot status-dot ${e.to_status}"></span>
          <span class="event-label">${escapeHtml(label)}</span>
          ${timeHtml(e.at, "event-age")}
          ${reasonHtml}
        </div>`;
      }).join("");

      // Close-the-loop affordance — shown only while the request is still open.
      // Two-tap: "Close this request" reveals a confirm so a stray tap can't
      // resolve it. Hidden once the loop is closed (vendor outcome or resolved).
      const canClose = !CLOSED_STATUSES.has(thread.item.status);
      const closing = closeState.kind === "loading";
      const closeErr = closeState.kind === "error" ? closeState.message : "";
      const closeHtml = canClose ? `
        <div class="rail-close">
          ${closeErr ? `<div class="err" data-live>${escapeHtml(closeErr)}</div>` : ""}
          ${closeConfirm ? `
            <p class="lede" style="margin:0 0 8px">${t.closeAsk}</p>
            <div class="row">
              <button class="outline" data-act="close-request-cancel" ${closing ? "disabled" : ""}>${t.cancel}</button>
              <button class="primary" data-act="close-request" ${closing ? "disabled" : ""}>${closing ? t.closing : t.closeRequest}</button>
            </div>
          ` : `
            <button class="outline rail-close-btn" data-act="close-request-ask" ${closing ? "disabled" : ""}>
              ${ICONS.check}<span>${closing ? t.closing : t.closeThis}</span>
            </button>
          `}
        </div>
      ` : "";

      // Where it stands, why and since when, in plain words, without opening
      // the rail: "Won't ship. Not in v2: the upkeep outweighs the use. 3 days ago"
      const reason = statusReason(thread.item);
      const since = thread.item.status_changed_at;
      body = `
        <div class="thread-grid">
          <div class="thread-messages">
            <div class="thread-meta">
              <span class="short-id">${escapeHtml(thread.item.short_id)}</span>
              ${statusPillHtml(thread.item.status)}
            </div>
            ${reason ? `<p class="status-note"><strong>${t.statuses[thread.item.status]}.</strong> ${escapeHtml(reason)}${since ? ` ${timeHtml(since, "event-age")}` : ""}</p>` : ""}
            ${msgs || `<p class="lede">${t.noMessages}</p>`}
            ${closeHtml}
          </div>
          <aside class="status-rail">
            <div class="rail-heading">${t.statusHeading}</div>
            ${eventsHtml || `<p class="lede" style="margin:0">${t.noHistory}</p>`}
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
    // No reply box under a thread that didn't load (it may not be theirs).
    panel.innerHTML = `
      ${header(headerTitle, footMeta || undefined, true, true)}
      <div class="body">${body}</div>
      ${threadState.kind === "error" ? "" : `<div class="foot">
        ${submitErr ? `<div class="err" data-live>${escapeHtml(submitErr)}</div>` : ""}
        ${pendingHtml()}
        <div class="row reply-row">
          <button class="ghost" data-act="pick-attachment" aria-label="${t.attachFile}" ${uploadingAttachment ? "disabled" : ""}>
            ${ICONS.attach}
          </button>
          <textarea class="field reply-box" data-act="reply" rows="1" maxlength="${MAX_LEN.reply}" aria-label="${t.yourReply}" placeholder="${uploadingAttachment ? t.uploading : t.replyHint}"></textarea>
          <button class="primary" data-act="send-reply" ${submitting ? `aria-label="${t.sending}"` : ""} ${submitting || uploadingAttachment ? "disabled" : ""}>
            ${ICONS.send}<span>${submitting ? "…" : t.send}</span>
          </button>
        </div>
      </div>`}`;
    // Focus lands here once, when the thread opens (setView); render() keeps
    // it wherever the customer moved it after that.
    const replyEl = panel.querySelector<HTMLTextAreaElement>('textarea[data-act="reply"]');
    if (replyEl) {
      replyEl.value = v.reply;
      autoGrow(replyEl);
    }
  }

  function renderConfirm(v: Extract<View, { kind: "confirm" }>) {
    // In the vendor's name, promising only what will happen: replies land
    // here, and by email when this deployment sends it and they haven't muted it.
    const n = me?.notifications;
    const byEmail = me?.email_enabled && n?.replies && !n.unsubscribed_all;
    panel.innerHTML = `
      ${header(t.shareFeedback, undefined, false)}
      <div class="body">
        <div class="empty">
          <span class="icon">${ICONS.check}</span>
          <h2 data-live>${t.feedbackSent}</h2>
          <p data-live>${t.willReply(escapeHtml(me?.workspace.name ?? ""), !!byEmail)}</p>
          <span class="short-id">${escapeHtml(v.shortId)}</span>
        </div>
      </div>
      <div class="foot">
        <div class="row">
          <button class="outline" data-act="see-list">${t.seeYourFeedback}</button>
          <div class="spacer"></div>
          <button class="primary" data-act="new">${ICONS.plus}<span>${t.sendAnother}</span></button>
        </div>
      </div>`;
  }

  // ── event delegation ───────────────────────────────────
  panel.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!target) return;
    const act = target.dataset.act;

    if (act === "close") { searchQuery = ""; closeApi(); return; }
    if (act === "toggle-expand") { expanded = !expanded; render(); return; }
    if (act === "back") {
      submitState = { kind: "idle" };
      memberMsg = null;
      expanded = false;
      // Back from a thread lands on its row, so a keyboard keeps its place.
      setView({ kind: "list" }, view.kind === "thread" ? `[data-short="${CSS.escape(view.shortId)}"]` : true);
      return;
    }
    if (act === "tab") {
      const t = target.dataset.tab;
      memberMsg = channelMsg = null;
      if (t === "admin") {
        setView({ kind: "admin" });
        if (config.jwt && me?.is_account_admin && !channels && channelsState.kind !== "loading") fetchChannels();
      }
      else if (t === "feedback") setView({ kind: "list" });
      else if (t === "roadmap") { setView({ kind: "roadmap" }); if (roadmap === null) fetchRoadmap(); }
      else if (t === "news") setView({ kind: "news" });
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
    // Removing a teammate or a channel asks first, in place; focus goes to
    // Cancel, and Cancel hands it back to the button that asked.
    if (act === "remove-ask") {
      askRemove = target.dataset.id ?? null;
      moveFocus = '[data-act="ask-cancel"]';
      render();
      return;
    }
    if (act === "ask-cancel") {
      moveFocus = `[data-act="remove-ask"][data-id="${CSS.escape(askRemove ?? "")}"]`;
      askRemove = null;
      render();
      return;
    }
    if (act === "member-remove" || act === "channel-remove") {
      const id = target.dataset.id;
      // The row goes, and focus with it: on to the next row's Remove, else the
      // list's heading. Never back up to the tabs.
      const removes = Array.from(target.closest(".admin-card")?.querySelectorAll<HTMLElement>(`[data-act="remove-ask"], [data-act="${act}"]`) ?? []);
      const next = removes.slice(removes.indexOf(target) + 1).find(el => el.dataset.act === "remove-ask");
      moveFocus = next ? `[data-act="remove-ask"][data-id="${CSS.escape(next.dataset.id ?? "")}"]`
        : act === "member-remove" ? "#crumb-members-head" : "#crumb-channels-head";
      askRemove = null;
      if (act === "member-remove" && id) removeMember(id);
      if (act === "channel-remove" && (id === "slack" || id === "teams")) void removeChannel(id);
      return;
    }
    if (act === "save-channels") { void saveChannels(); return; }
    if (act === "retry") {
      if (view.kind === "thread") fetchThread(view.shortId);
      else if (view.kind === "roadmap") fetchRoadmap();
      else if (view.kind === "admin") void (me ? fetchChannels() : fetchMe());
      else fetchList();
      return;
    }
    if (act === "follow") {
      const id = target.dataset.id;
      if (id) toggleFollow(id, target.dataset.following !== "1");
      return;
    }
    if (act === "new") {
      submitState = { kind: "idle" };
      const c = readDrafts().compose; // pick up an unsent draft
      setView({ kind: "compose", type: c?.type ?? "idea", title: c?.title ?? "", body: c?.body ?? "" });
      return;
    }
    if (act === "see-list") {
      setView({ kind: "list" });
      return;
    }
    if (act === "open-thread") {
      const sid = target.dataset.short;
      if (sid) openThread(sid);
      return;
    }
    if (act === "type" && view.kind === "compose") {
      const t = target.dataset.type as ItemType | undefined;
      submitState = { kind: "idle" };
      if (t) {
        const { title, body } = view;
        editDrafts(d => { d.compose = { type: t, title, body }; });
        view = { ...view, type: t }; // same view: focus stays on the picked type
        render();
      }
      return;
    }
    if (act === "record-consent") {
      // Ticked: the recorder sends the minutes it kept and records on (the
      // session_token links to whatever they submit). Unticked: it stops and
      // drops what it hadn't sent; ticking again starts a fresh session.
      const on = (target as HTMLInputElement).checked;
      writeRecordChoice(userKey(), on);
      if (on) loadRecorder(config.apiBase, syncRecorder);
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
    if (act === "close-request-ask" && view.kind === "thread") {
      closeConfirm = true;
      closeState = { kind: "idle" };
      moveFocus = '[data-act="close-request-cancel"]'; // the safe choice
      render();
      return;
    }
    if (act === "close-request-cancel") {
      closeConfirm = false;
      moveFocus = '[data-act="close-request-ask"]';
      render();
      return;
    }
    if (act === "close-request" && view.kind === "thread") {
      closeRequest(view);
      return;
    }
    if (act === "pick-attachment") {
      pickAndUploadAttachment();
      return;
    }
    if (act === "capture") {
      void captureScreenshot();
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
    if (view.kind === "list" && act === "search") {
      searchQuery = (target as HTMLInputElement).value;
      // Pull the roadmap in lazily the first time someone searches, so its
      // initiatives can join the results (only if this workspace has one).
      if (searchQuery.trim() && roadmap === null && me?.has_roadmap) fetchRoadmap();
      // Re-render only the results container so the input keeps focus + caret.
      const box = panel.querySelector("[data-results]");
      if (box) box.innerHTML = buildResultsHtml();
      return;
    }
    if (view.kind === "compose") {
      if (act === "title") { view = { ...view, title: (target as HTMLInputElement).value }; }
      if (act === "body")  { view = { ...view, body:  (target as HTMLTextAreaElement).value }; }
      submitState = { kind: "idle" };
      const { type, title, body } = view;
      editDrafts(d => { d.compose = { type, title, body }; });
    } else if (view.kind === "thread" && act === "reply") {
      const reply = (target as HTMLTextAreaElement).value;
      const sid = view.shortId;
      view = { ...view, reply };
      autoGrow(target as HTMLTextAreaElement);
      editDrafts(d => { d.replies = { ...d.replies, [sid]: reply }; });
    }
  });

  panel.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.getAttribute("role") === "tab") {
      const tabs = Array.from(panel.querySelectorAll<HTMLElement>('[role="tab"]'));
      const to = tabs[tabStep(e.key, tabs.indexOf(t), tabs.length)];
      // Selection follows focus: the click switches views, and render()
      // focuses the newly selected tab.
      if (to) { e.preventDefault(); to.click(); }
      return;
    }
    if (!isSendShortcut(e)) return;
    const act = (e.target as HTMLElement).dataset?.act;
    if (view.kind === "thread" && act === "reply") { e.preventDefault(); submitReply(view); }
    else if (view.kind === "compose" && (act === "title" || act === "body")) { e.preventDefault(); submitNew(view); }
  });

  scrim.addEventListener("click", () => {
    if (expanded) { expanded = false; render(); }
  });

  launcher.addEventListener("click", () => { if (open) closeApi(); else openApi(); });

  // First paint must NOT wait on the /me round-trip (which can be 1–3s on a
  // cold serverless function or dev compile). We reveal the launcher
  // immediately using branding cached from a previous visit — or right-edge
  // defaults on the very first ever load — then refresh colors/edge in
  // place when /me resolves and cache it for next time.
  const cachedBrand = readCachedBrand();
  settleLauncher({
    dot: cachedBrand?.accent ?? null,
    bg: cachedBrand?.launcher_bg ?? null,
    edge: cachedBrand?.launcher_edge ?? null,
    visibility: cachedBrand?.launcher_visibility ?? null,
    offsetY: cachedBrand?.launcher_offset_y ?? null,
  });

  // Load (or, after identify(), reload in place) what the launcher and the
  // open view need. The list loads before the panel is ever opened so the
  // launcher can surface replies that arrived while the customer was away;
  // a failure there stays quiet until they open the panel.
  function boot() {
    void fetchMe();
    fetchList();
    if (!open) return;
    if (news === null && newsState.kind !== "loading") void fetchNews();
    if (view.kind === "thread" && threadState.kind === "error") fetchThread(view.shortId);
    else if (view.kind === "roadmap" && roadmapState.kind === "error") fetchRoadmap();
  }
  if (identified()) boot();

  // Honor `?crumb_open=FB-N`, the deep link in customer notification emails:
  // pop the panel straight to that thread, once. Held until identify() when
  // nobody's signed in yet, and stripped from the URL so a reload doesn't
  // reopen it (history.state kept for the host's router).
  function maybeAutoOpen() {
    try {
      const url = new URL(location.href);
      const sid = url.searchParams.get("crumb_open");
      if (!sid) return;
      if (identified()) openApi(sid);
      else pendingOpen = sid;
      url.searchParams.delete("crumb_open");
      history.replaceState(history.state, "", url.href);
    } catch {
      /* sandboxed host without history access: ignore */
    }
  }
  maybeAutoOpen();

  document.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Tab") trapTab(e);
    else if (e.key === "Escape" && !e.isComposing) {
      // Two-stage: collapse first, then close. Mirrors the way most modals
      // dismiss a deeper layer before closing the whole thing.
      if (expanded) { expanded = false; render(); }
      else closeApi();
    }
  });

  // Last-chance flush of buffered usage events when the page goes away.
  window.addEventListener("pagehide", () => { try { flushUsage(); } catch { /* ignore */ } });

  // ── public API: replace the queuing stub and drain it ──────
  function openApi(shortId?: string) {
    if (!identified()) return; // nobody signed in: nothing to show yet
    if (!open) {
      // Closing hands focus back to what opened us: the host's own button,
      // else (focus was on our launcher, or nowhere) the launcher.
      const a = document.activeElement;
      opener = a instanceof HTMLElement && a !== document.body && a !== host ? a : null;
      moveFocus = true;
    }
    open = true;
    if (me === null && meState.kind !== "loading") void fetchMe();
    // Refresh on every open so new vendor replies show (unless one's in flight).
    if (listState.kind !== "loading") fetchList();
    // What's new loads once a page (its tab appears with it), not on page load.
    if (news === null && newsState.kind !== "loading") void fetchNews();
    if (shortId) openThread(shortId);
    else render();
  }
  function closeApi() {
    // Only an open panel hands focus back: from inside it, or from <body>
    // where it fell while the panel was up. A host's crumb.close() on a
    // closed panel leaves the customer's focus alone.
    const a = shadow.activeElement;
    const ours = open && (a ? panel.contains(a) : document.activeElement === document.body);
    if (open && view.kind === "list") markAllStatusesSeen();
    if (open && view.kind === "news") markNewsSeen();
    open = false;
    expanded = false;
    render();
    // Focus that was in the panel goes back to the opener; focus out on the
    // host page (or already on the launcher) stays put.
    if (ours) (opener?.isConnected ? opener : launcher).focus();
  }

  function openThread(sid: string) {
    submitState = { kind: "idle" };
    setView({ kind: "thread", shortId: sid, reply: readDrafts().replies?.[sid] ?? "" });
    fetchThread(sid);
  }

  // Forget the signed-in customer: their data, drafts, unread caches and
  // recording consent. Shared by shutdown() and a user switch in identify().
  function forgetUser() {
    flushUsage(); // their buffered events still go out as them
    usageBuffer = [];
    try { sessionStorage.removeItem(draftKey()); } catch { /* storage blocked */ }
    // Their consent, recording and session can't carry over to whoever signs
    // in next: the recorder drops what it holds and the token goes.
    try { window.__crumbRecord__?.stop(); } catch { /* ignore */ }
    clearRecordChoice();
    epoch++;
    me = null; items = null; thread = null; roadmap = null; news = null;
    meState = listState = threadState = roadmapState = newsState = submitState = closeState = { kind: "idle" };
    view = { kind: "list" };
    searchQuery = "";
    closeConfirm = false;
    pendingAttachments = [];
    attachFor = "";
    uploadingAttachment = false;
    attachmentError = memberMsg = channelMsg = followMsg = askRemove = null;
    channels = null;
    channelsState = { kind: "idle" };
    seenCache = statusSeenCache = null;
    panel.innerHTML = ""; // nothing of theirs left in the page, open or closed
    live.textContent = "";
    clearTimeout(liveTimer);
  }

  function identify(opts?: { jwt?: unknown }) {
    const jwt = typeof opts?.jwt === "string" ? opts.jwt.trim() : "";
    if (!jwt) { console.warn("[crumb] identify() needs { jwt } with a signed identity token."); return; }
    if (jwt === config.jwt) return;
    // Someone else (or a token we can't read): nothing of the last customer stays.
    const sub = jwtSub(jwt);
    if (identified() && (!sub || sub !== userKey())) forgetUser();
    config.jwt = jwt;
    config.userEmail = "";
    config.userName = undefined;
    config.accountName = "";
    // A fresh token clears notes that said the old one had expired.
    if (submitState.kind === "error") submitState = { kind: "idle" };
    if (closeState.kind === "error") closeState = { kind: "idle" };
    attachmentError = null;
    settleLauncher({});
    boot();
    if (pendingOpen) { const sid = pendingOpen; pendingOpen = null; openApi(sid); }
  }

  function shutdown() {
    if (identified()) forgetUser();
    config.jwt = undefined;
    config.userEmail = "";
    config.userName = undefined;
    config.accountName = "";
    pendingOpen = null;
    applyVisibility();
    closeApi();
    panel.innerHTML = ""; // and nothing re-rendered on the way out
  }

  const queued = window.crumb?.q ?? [];
  const api: CrumbApi = {
    open: openApi,
    close: closeApi,
    toggle: () => { if (open) closeApi(); else openApi(); },
    track,
    onReady: (cb) => { try { queueMicrotask(() => cb()); } catch { setTimeout(cb, 0); } },
    onUnread: (cb) => {
      unreadListeners.push(cb);
      if (lastUnread >= 0) { try { cb(lastUnread); } catch { /* host cb */ } }
    },
    identify,
    shutdown,
    onTokenExpired: (cb) => {
      expiredListeners.push(cb);
      // Registered after this token already expired: tell them now.
      if (config.jwt && expiredJwt === config.jwt) { try { cb(); } catch { /* host cb */ } }
    },
    // The server caps and checks it; null or "" clears it.
    setContext: (ctx) => {
      const v = ctx?.app_version;
      if (typeof v === "string" || v === null) appVersion = v?.trim() ?? "";
    },
    __mounted: true,
  };
  window.crumb = api;
  for (const [name, args] of queued) {
    const fn = api[name];
    if (typeof fn === "function") {
      try { (fn as (...a: unknown[]) => void)(...args); } catch { /* host call */ }
    }
  }
  if (!identified()) console.info("[crumb] No signed-in customer yet. The launcher appears after crumb.identify({ jwt }).");

  render();
}

installApiStub();

const cfg = readConfig();
if (cfg) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init(cfg), { once: true });
  } else {
    init(cfg);
  }
}
