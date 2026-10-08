// CSS for the widget's shadow root: Crumb's look, without leaking onto the
// host page or catching its styles. Design is DESIGN.md's warm paper (cream,
// toasted brown, ember as the one accent), adapted for embedding.
//
// This ships inside widget.js, so the notes live in these TS comments, which
// the build drops, and build.mjs runs minifyCss on the string itself (esbuild
// can't look inside one), so widget.js carries no spare whitespace either.

// Comments out; whitespace down to one space, and none beside { } ; , or
// after a declaration's colon. Strings and url() pass through untouched.
export function minifyCss(css: string): string {
  return css.replace(
    /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\(\s*(?:\\[\s\S]|[^\s"'()\\])*\s*\))|(?:\s|\/\*[\s\S]*?\*\/)*([{};,]|:(?=\s))(?:\s|\/\*[\s\S]*?\*\/)*|(?:\s|\/\*[\s\S]*?\*\/)+/g,
    (_: string, keep?: string, mark?: string) => keep || mark || " ",
  ).trim();
}

export const css =
// Tokens sit on :host so the whole widget tunes from one place. Status colors
// mirror the dashboard, so a loop reads the same color to both sides. Text
// tokens clear 4.5:1 on every panel surface (unit-tested): ink-3 is for dots
// only; accent-ink is ember-deep darkened until it passes (DESIGN.md's
// #B45F23 reads 4.3:1 on cream); errors take rust-deep, since plain rust
// misses on its own wash. Radii keep DESIGN.md's names and 4 to 10px scale:
// md for controls, lg for cards, rows and messages, xl for the floating panel.
// The launcher's two colors are the workspace's (set by JS from /me); the
// near-black is only for unbranded installs. Inside the panel the accent
// fills the primary button and draws the focus ring (--c-brand, set by JS
// only when white text on it reads at 4.5:1; else the fallbacks below).
`
:host {
  all: initial;
  --c-bg: #FBF7F0;
  --c-surface-2: #F4EEE2;
  --c-ink: #4A2E1F;
  --c-ink-2: #6A4528;
  --c-ink-3: #8A8278;
  --c-line: rgba(74, 46, 31, 0.10);
  --c-line-2: rgba(74, 46, 31, 0.16);
  --c-accent: #E27D3A;
  --c-accent-ink: #9A4D1B;
  --c-accent-soft: rgba(226, 125, 58, 0.10);
  --c-green: #6B8E5A;
  --c-amber: #D4A24C;
  --c-rust: #B3573A;
  --c-rust-deep: #8A3A3A;
  --r-md: 6px;
  --r-lg: 8px;
  --r-xl: 10px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --crumb-launcher-bg: #1C1A17;
  --crumb-accent: #E27D3A;
}
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
:focus-visible { outline: 2px solid var(--c-brand, var(--c-accent-ink)); outline-offset: 2px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
` +
// The launcher, an edge whisper tab: slim, flat, docked flush to a viewport
// edge and vertically centered, with borders for depth and one hairline
// shadow. It earns presence only with loop news (.l-dot and 2px of width);
// hover or focus slides out a flat paper flag with the latest event ("Maya
// replied · 2"). The flag is part of the button, so it stays open under the
// cursor and clicks through. Mark, label and dot all wear the brand "dot
// color" from Branding, so one choice styles the tab and the dashboard's
// dot-on-background contrast warning covers the label too.
`
.launcher {
  position: fixed;
  right: 0;
  top: calc(50% + var(--crumb-offset-y, 0px));
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 28px;
  padding: 12px 0;
  background: var(--crumb-launcher-bg);
  color: #FFFFFF;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-right: 0;
  border-radius: var(--r-lg) 0 0 var(--r-lg);
  box-shadow: 0 1px 2px rgba(74, 46, 31, 0.08);
  cursor: pointer;
  transition: width 200ms cubic-bezier(0.25, 1, 0.5, 1), background 200ms cubic-bezier(0.25, 1, 0.5, 1);
  z-index: 2147483646;
}
:host([data-edge="left"]) .launcher {
  left: 0; right: auto;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
  border-left: 0;
  border-radius: 0 var(--r-lg) var(--r-lg) 0;
}
.launcher[data-state="news"] { width: 30px; }
.launcher:hover, .launcher:focus-visible { width: 32px; }
.launcher:focus-visible { outline: 2px solid var(--crumb-accent); outline-offset: 2px; }
.launcher .l-mark { display: inline-flex; }
.launcher .l-mark svg { width: 16px; height: 16px; overflow: visible; }
.launcher svg circle { fill: var(--crumb-accent); transition: fill 240ms var(--ease); }
.launcher .l-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--crumb-accent);
  user-select: none;
}
.launcher .l-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--crumb-accent); }
.launcher .l-dot[hidden] { display: none; }
.launcher .l-flag {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%) translateX(4px);
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  background: var(--c-bg);
  color: var(--c-ink);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-md);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(74, 46, 31, 0.08);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms cubic-bezier(0.25, 1, 0.5, 1), transform 200ms cubic-bezier(0.25, 1, 0.5, 1);
}
:host([data-edge="left"]) .launcher .l-flag {
  right: auto;
  left: calc(100% + 8px);
  transform: translateY(-50%) translateX(-4px);
}
.launcher:hover .l-flag, .launcher:focus-visible .l-flag {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
.launcher .l-flag-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.launcher .l-flag-count { color: var(--c-accent-ink); font-weight: 600; }
.launcher .l-flag-count:empty { display: none; }
` +
// The panel sits beside the tab, centered on the same nudge the launcher
// tracks, a small inset off the edge. It floats over any host page, light,
// dark or busy, so it takes a real (warm) shadow; soften it only after
// trying /widget-demo.html against a real product. Expanded, it centers over
// a scrim.
`
.panel {
  position: fixed;
  right: 16px;
  top: calc(50% + var(--crumb-offset-y, 0px));
  width: 392px;
  max-width: calc(100vw - 40px);
  height: 620px;
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
  background: var(--c-bg);
  border: 1px solid var(--c-line);
  border-radius: var(--r-xl);
  box-shadow:
    0 1px 2px rgba(74, 46, 31, 0.04),
    0 4px 12px rgba(74, 46, 31, 0.06),
    0 16px 40px rgba(74, 46, 31, 0.14);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transform: translateY(-50%) translateX(8px) scale(0.985);
  transform-origin: right center;
  pointer-events: none;
  transition: opacity 180ms var(--ease), transform 220ms var(--ease), width 220ms var(--ease), height 220ms var(--ease), right 220ms var(--ease), top 220ms var(--ease);
  z-index: 2147483647;
}
.panel.open {
  opacity: 1;
  transform: translateY(-50%) translateX(0) scale(1);
  pointer-events: auto;
}
:host([data-edge="left"]) .panel {
  left: 16px; right: auto;
  transform-origin: left center;
  transform: translateY(-50%) translateX(-8px) scale(0.985);
}
:host([data-edge="left"]) .panel.open {
  transform: translateY(-50%) translateX(0) scale(1);
}
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(74, 46, 31, 0.40);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms var(--ease);
  z-index: 2147483646;
}
.scrim.show { opacity: 1; pointer-events: auto; }
.panel.expanded {
  right: 50%;
  top: 50%;
  transform: translate(50%, -50%);
  width: min(780px, calc(100vw - 48px));
  height: min(720px, calc(100vh - 48px));
  height: min(720px, calc(100dvh - 48px));
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
}
.panel.expanded.open { transform: translate(50%, -50%); }
:host([data-edge="left"]) .panel.expanded,
:host([data-edge="left"]) .panel.expanded.open {
  left: 50%; right: auto;
  transform: translate(-50%, -50%);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--c-line);
}
.head .back, .head .close {
  appearance: none; background: transparent; border: 0;
  width: 30px; height: 30px; border-radius: var(--r-lg);
  display: grid; place-items: center; cursor: pointer; color: var(--c-ink-2);
  transition: background 120ms var(--ease), color 120ms var(--ease);
}
.head .back:hover, .head .close:hover { background: var(--c-surface-2); color: var(--c-ink); }
.head .title { font-weight: 600; color: var(--c-ink); font-size: 15px; letter-spacing: -0.01em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .sub { font-size: 12px; color: var(--c-ink-2); }
.head svg { width: 16px; height: 16px; }
.brand-mark { display: inline-flex; }
.brand-mark svg circle { fill: var(--c-accent); }

.body {
  padding: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--c-ink);
  flex: 1;
}
.tabpanel { display: flex; flex-direction: column; gap: 14px; flex: 1 0 auto; }
.lede { font-size: 13.5px; line-height: 1.55; color: var(--c-ink-2); margin: 0 0 2px; }

.foot {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--c-line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.foot .meta { font-size: 11px; color: var(--c-ink-2); flex: 1; }
.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }
` +
// Tabs: underlined, ember on the selected one.
`
.tabs {
  display: inline-flex;
  gap: 18px;
  border-bottom: 1px solid var(--c-line);
  align-self: stretch;
}
.tab {
  appearance: none;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 6px 0 9px;
  margin-bottom: -1px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--c-ink-2);
  cursor: pointer;
  transition: color 120ms var(--ease), border-color 120ms var(--ease);
}
.tab:hover { color: var(--c-ink); }
.tab[aria-selected="true"] {
  color: var(--c-ink);
  border-bottom-color: var(--c-accent);
}
` +
// Buttons. Flat on paper, so no hover lift or shadow: primary goes from ink
// to brown-2, and a vendor accent (.branded) darkens a step instead, which
// keeps white text on it above 4.5:1.
`
button.primary {
  appearance: none;
  background: var(--c-brand, var(--c-ink));
  color: #FFFFFF;
  border: 0;
  padding: 10px 16px;
  border-radius: var(--r-md);
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background-color 120ms var(--ease), opacity 120ms var(--ease);
}
button.primary:hover:not(:disabled) { background-color: var(--c-ink-2); }
.branded button.primary:hover:not(:disabled) { background: linear-gradient(rgba(74, 46, 31, 0.18), rgba(74, 46, 31, 0.18)) var(--c-brand); }
button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary svg { width: 13px; height: 13px; }

button.outline {
  appearance: none; background: var(--c-bg);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-md); padding: 9px 13px;
  font: inherit; font-size: 12.5px; color: var(--c-ink); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background 120ms var(--ease);
}
button.outline:hover { background: var(--c-surface-2); }
button.outline:disabled, button.outline[aria-disabled="true"] { opacity: 0.5; cursor: default; }
button.outline svg { width: 13px; height: 13px; }

button.ghost {
  appearance: none; background: none;
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-lg);
  padding: 8px;
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  font: inherit; color: var(--c-ink);
  transition: background 120ms var(--ease);
}
button.ghost:hover { background: var(--c-surface-2); }
button.ghost:disabled { opacity: 0.5; cursor: default; }
button.ghost svg { width: 14px; height: 14px; }
` +
// Fields: the focus signature is a brand (else ember) border and soft glow.
// Placeholders are brown at 74%, 5.3:1 on cream (unit-tested at 4.5).
`
input.field, textarea.field {
  appearance: none;
  width: 100%;
  background: var(--c-bg);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-md);
  padding: 10px 12px;
  font: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--c-ink);
  resize: vertical;
  transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
}
input.field::placeholder, textarea.field::placeholder { color: rgba(74, 46, 31, 0.74); }
input.field:focus, textarea.field:focus {
  outline: none;
  border-color: var(--c-brand, var(--c-accent));
  box-shadow: 0 0 0 3px var(--c-brand-soft, var(--c-accent-soft));
}
textarea.field { min-height: 84px; }
.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--c-ink-2);
  display: block;
  margin-bottom: 6px;
}

.err {
  background: rgba(179, 87, 58, 0.08);
  border: 1px solid rgba(179, 87, 58, 0.22);
  color: var(--c-rust-deep);
  padding: 9px 11px;
  border-radius: var(--r-md);
  font-size: 12.5px;
}
.err-retry {
  appearance: none; background: none; border: 0; padding: 0; margin-left: 2px;
  font: inherit; font-weight: 600; color: inherit; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
` +
// Loading is a warm shimmer, cream-2 to cream-soft, never a spinner.
`
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skel {
  border-radius: var(--r-lg);
  background: linear-gradient(100deg, var(--c-surface-2) 30%, #FDFAF4 50%, var(--c-surface-2) 70%);
  background-size: 220% 100%;
  animation: crumb-shimmer 1.3s var(--ease) infinite;
}
.skel.row { height: 58px; }
@keyframes crumb-shimmer { from { background-position: 180% 0; } to { background-position: -40% 0; } }

.empty {
  text-align: center;
  padding: 24px 12px 6px;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  margin: auto 0;
}
.empty .icon {
  width: 44px; height: 44px;
  border-radius: 999px;
  background: var(--c-accent-soft);
  color: var(--c-accent);
  display: grid; place-items: center;
}
.empty .icon svg { width: 20px; height: 20px; }
.empty .icon.warn { background: rgba(179, 87, 58, 0.10); color: var(--c-rust-deep); }
.empty h2 { margin: 2px 0 0; font-size: 18px; font-weight: 600; color: var(--c-ink); letter-spacing: -0.015em; }
.empty p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--c-ink-2); max-width: 32ch; }
` +
// The feedback list, its search, and status pills. A status dot carries the
// status family's color (ember planned and in progress, green shipped, rust
// won't ship, amber set aside); open is a hollow ring and duplicate a dashed
// one. Customer-closed is a softer green than shipped, so a loop they closed
// themselves never reads as a shipped outcome.
`
.search-input { flex: none; }
.results { display: flex; flex-direction: column; gap: 14px; }
.results-section { display: flex; flex-direction: column; gap: 8px; }
.results-head {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--c-ink-2);
}
.items-list { display: flex; flex-direction: column; gap: 8px; }
.item-row {
  appearance: none;
  text-align: left;
  background: var(--c-bg);
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
  padding: 13px 14px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 7px;
  transition: background 120ms var(--ease), border-color 120ms var(--ease), transform 120ms var(--ease);
}
.item-row:hover { background: var(--c-surface-2); border-color: var(--c-line-2); }
.item-row:active { transform: scale(0.995); }
.item-row .top { display: flex; align-items: center; gap: 8px; }
.news-dot { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 999px; background: var(--c-brand, var(--c-accent-ink)); }
.tab .news-dot { width: 6px; height: 6px; margin-left: 6px; vertical-align: 2px; }
.item-row .short { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--c-ink-2); }
.item-row .age { margin-left: auto; font-size: 11px; color: var(--c-ink-2); white-space: nowrap; }
.item-row .title { font-size: 13.5px; color: var(--c-ink); font-weight: 500; line-height: 1.45; word-wrap: break-word; }
.item-row .bottom { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-ink-2); }

.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 8px; border-radius: 999px;
  border: 1px solid var(--c-line-2);
  font-size: 11px; color: var(--c-ink-2);
}
.status-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--c-ink-3); display: inline-block; }
.status-dot.open { background: transparent; border: 1.5px solid var(--c-ink-2); box-sizing: content-box; width: 5px; height: 5px; }
.status-dot.review { box-shadow: inset 0 0 0 1.5px var(--c-ink); }
.status-dot.planned { background: var(--c-accent); opacity: 0.55; }
.status-dot.progress { background: var(--c-accent); }
.status-dot.shipped { background: var(--c-green); }
.status-dot.declined { background: var(--c-rust); }
.status-dot.deferred { background: var(--c-amber); }
.status-dot.duplicate { background: transparent; border: 1.5px dashed var(--c-ink-3); box-sizing: content-box; width: 4px; height: 4px; }
.status-dot.resolved { background: var(--c-green); opacity: 0.55; }
.short-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--c-ink-2);
}
` +
// Compose, and files waiting to go out with a send.
`
.types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.type-btn {
  appearance: none;
  background: var(--c-bg);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-md);
  padding: 11px 6px;
  font-size: 12px;
  color: var(--c-ink-2);
  cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  transition: background 120ms var(--ease), border-color 120ms var(--ease), color 120ms var(--ease);
}
.type-btn:hover { background: var(--c-surface-2); }
.type-btn[aria-pressed="true"] {
  border-color: var(--c-accent);
  background: var(--c-accent-soft);
  color: var(--c-ink);
}
.type-btn svg { width: 15px; height: 15px; }
.attach-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.attach-note { font-size: 12px; color: var(--c-ink-2); }

.attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-lg);
  background: var(--c-bg);
  text-decoration: none;
  color: var(--c-ink);
  font-size: 11px;
  max-width: 100%;
}
.attachment svg { width: 11px; height: 11px; opacity: 0.55; }
.attachment .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.attachment .size { font-size: 10px; color: var(--c-ink-2); }
.attachment:hover { background: var(--c-surface-2); }

.pending-attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 8px 6px; }
.body .pending-attachments { padding: 0; }
.pending-attachment {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 4px 5px 9px;
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-lg);
  background: var(--c-bg);
  font-size: 11px;
}
.pending-attachment svg { width: 11px; height: 11px; opacity: 0.55; }
.pending-attachment .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
.pending-attachment .size { font-size: 10px; color: var(--c-ink-2); }
.pending-attachment button { background: none; border: 0; padding: 7px; margin: -5px; cursor: pointer; color: var(--c-ink-2); }
` +
// A thread: one column at the default size; expanded, the status history
// opens as a side rail. The reply box is one line at rest and autoGrow()
// sets its height.
`
.thread-grid { display: flex; flex-direction: column; gap: 16px; }
.thread-messages { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.status-rail { display: none; }
.panel.expanded .thread-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px;
  gap: 28px;
  align-items: start;
}
.panel.expanded .status-rail {
  display: block;
  padding-left: 18px;
  border-left: 1px solid var(--c-line);
}
.thread-meta {
  font-size: 11px; color: var(--c-ink-2);
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--c-line);
  margin-bottom: 2px;
}
.status-note {
  margin: 0; padding: 10px 12px;
  border: 1px solid var(--c-line-2); border-radius: var(--r-lg);
  font-size: 13px; line-height: 1.5; color: var(--c-ink);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.status-note strong { font-weight: 600; }
.msg {
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
  padding: 11px 13px;
  background: var(--c-surface-2);
}
.msg.vendor { background: var(--c-ink); color: #FFFFFF; border-color: transparent; }
.msg .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 11px; color: var(--c-ink-2); }
.msg.vendor .meta { color: rgba(255, 255, 255, 0.6); }
.msg .meta .when { margin-left: auto; white-space: nowrap; }
.msg .avatar {
  width: 24px; height: 24px; border-radius: 999px;
  background: var(--c-line-2); color: var(--c-ink);
  display: grid; place-items: center; font-size: 10px; font-weight: 600;
}
.msg.vendor .avatar { background: var(--c-accent-ink); color: #FFFFFF; }
.msg p { margin: 0; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; }
.rail-close { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--c-line); }
.rail-close-btn { width: 100%; justify-content: center; }
textarea.field.reply-box { flex: 1; min-height: 0; max-height: 160px; resize: none; overflow-y: auto; }
.foot .row.reply-row { align-items: flex-end; }

.rail-heading {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--c-ink-2);
  font-weight: 600;
  margin-bottom: 12px;
}
.event {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}
.event-dot { width: 8px; height: 8px; border-radius: 999px; }
.event-label { font-size: 12px; color: var(--c-ink); }
.event-age { font-size: 11px; color: var(--c-ink-2); white-space: nowrap; }
.event-reason {
  grid-column: 2 / -1;
  font-size: 11px;
  line-height: 1.5;
  color: var(--c-ink-2);
  font-style: italic;
  padding: 4px 0 2px 8px;
  border-left: 1px solid var(--c-line-2);
  margin-left: -2px;
  margin-top: 2px;
}
` +
// The public roadmap (Now / Next / Later, then Recently shipped), each card
// with its status; What's new as a plain list of entries; email settings as
// switches.
`
.rm-board { display: flex; flex-direction: column; gap: 18px; }
.rm-col { display: flex; flex-direction: column; gap: 8px; }
.rm-col-head {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--c-ink-2);
}
.rm-results { display: flex; flex-direction: column; gap: 8px; }
.rm-card {
  border: 1px solid var(--c-line); border-radius: var(--r-lg);
  padding: 11px 13px; background: var(--c-bg);
  display: flex; flex-direction: column; gap: 6px;
}
.rm-card-top { display: flex; align-items: center; gap: 8px; }
.rm-name { font-size: 13.5px; font-weight: 500; color: var(--c-ink); flex: 1; line-height: 1.4; }
.rm-desc { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--c-ink-2); }
.rm-follow {
  appearance: none; flex-shrink: 0;
  background: transparent; border: 1px solid var(--c-line-2);
  border-radius: 999px; padding: 4px 11px;
  font: inherit; font-size: 12px; font-weight: 500; color: var(--c-ink-2);
  cursor: pointer;
  transition: background 120ms var(--ease), color 120ms var(--ease), border-color 120ms var(--ease);
}
.rm-follow:hover { background: var(--c-surface-2); color: var(--c-ink); }
.rm-follow.on { background: var(--c-accent-soft); border-color: var(--c-accent); color: var(--c-accent-ink); }
.rm-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--c-ink-2); }

.news-list { display: flex; flex-direction: column; }
.news-entry { display: flex; flex-direction: column; gap: 4px; padding: 14px 2px; }
.news-entry:first-child { padding-top: 2px; }
.news-entry + .news-entry { border-top: 1px solid var(--c-line); }
.news-top { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-ink-2); }
.news-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.4; letter-spacing: -0.01em; color: var(--c-ink); overflow-wrap: anywhere; }
.news-body { margin: 0; font-size: 13px; line-height: 1.55; color: var(--c-ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }

.set-row { display: flex; align-items: center; gap: 12px; padding: 11px 0; }
.set-row + .set-row { border-top: 1px solid var(--c-line); }
.set-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.set-label { font-size: 13.5px; font-weight: 500; color: var(--c-ink); }
.set-sub { font-size: 11.5px; color: var(--c-ink-2); line-height: 1.4; }
.set-divider { height: 1px; background: var(--c-line); margin: 6px 0; }
.set-row.disabled { opacity: 0.5; }
.sw {
  flex-shrink: 0;
  width: 38px; height: 22px; border-radius: 999px;
  background: var(--c-line-2); border: 0; cursor: pointer; padding: 0;
  position: relative; transition: background 160ms var(--ease);
}
.sw::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 999px; background: #fff;
  box-shadow: 0 1px 2px rgba(74, 46, 31, 0.3); transition: transform 160ms var(--ease);
}
/* A clear layer stretches the 22px-high track to a 24px target, per WCAG 2.5.8. */
.sw::before { content: ""; position: absolute; inset: -1px 0; }
.sw.on { background: var(--c-accent); }
.sw.on::after { transform: translateX(16px); }
.sw:disabled { cursor: default; }
` +
// The Admin tab: the account's teammates, and its Slack or Teams channel.
`
.admin-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px;
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
  background: var(--c-surface-2);
}
.admin-card-head { display: flex; align-items: center; gap: 8px; }
.admin-card-title { font-weight: 600; font-size: 13px; color: var(--c-ink); flex: 1; }
.admin-card-sub { font-size: 11px; color: var(--c-ink-2); }
.text-sm { font-size: 13px; }
.muted { color: var(--c-ink-2); }
.members { display: flex; flex-direction: column; gap: 8px; }
.member-row { display: flex; align-items: center; gap: 10px; }
.member-avatar {
  width: 28px; height: 28px;
  border-radius: 999px;
  background: var(--c-line-2);
  color: var(--c-ink);
  display: grid; place-items: center;
  font-size: 10px; font-weight: 600;
  flex-shrink: 0;
}
.member-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.member-name { font-size: 13px; color: var(--c-ink); font-weight: 500; display: flex; align-items: center; gap: 6px; }
.member-you {
  font-size: 10px; color: var(--c-ink-2); font-weight: 400;
  background: var(--c-surface-2);
  padding: 1px 6px; border-radius: 999px;
}
.member-email { font-size: 11px; color: var(--c-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.role-pill {
  font-size: 10px;
  color: var(--c-accent-ink);
  background: var(--c-accent-soft);
  padding: 2px 8px; border-radius: 999px;
}
.member-count {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: var(--c-ink-2);
  min-width: 18px; text-align: right;
}
.member-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.member-role {
  font-size: 11px; font-weight: 500; color: var(--c-ink-2);
  background: var(--c-surface-2); border: 1px solid var(--c-line);
  padding: 3px 9px; border-radius: 999px; cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.member-role:hover { background: var(--c-bg); color: var(--c-ink); border-color: var(--c-line-2); }
.member-role.danger, .member-role.danger:hover { background: var(--c-rust-deep); color: var(--c-bg); border-color: transparent; }
.member-remove {
  width: 26px; height: 26px; border-radius: var(--r-lg);
  background: none; border: 0; cursor: pointer; color: var(--c-ink-2);
  display: grid; place-items: center;
}
.member-remove svg { width: 14px; height: 14px; }
.member-remove:hover { background: var(--c-surface-2); color: var(--c-rust); }
.channel-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.channel-name { font-weight: 500; color: var(--c-ink); }
.channel-url { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--c-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
` +
// Phones get a full-screen sheet with 44px targets. The selectors match every
// docked, expanded and open rule above (which set left: 50% at up to 0,5,0).
// iOS zooms in on a focused field under 16px, so touch screens get 16px.
`
@media (max-width: 479px) {
  .panel, .panel.expanded, :host([data-edge="left"]) .panel,
  :host([data-edge="left"]) .panel.expanded, :host([data-edge="left"]) .panel.expanded.open {
    inset: 0; width: 100%; max-width: none; height: 100vh; height: 100dvh; max-height: none;
    border: 0; border-radius: 0; transform: translateY(12px);
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .panel.open, .panel.expanded.open,
  :host([data-edge="left"]) .panel.open, :host([data-edge="left"]) .panel.expanded.open { transform: none; }

  .panel.expanded .thread-grid { display: flex; flex-direction: column; align-items: stretch; gap: 16px; }
  .panel.expanded .status-rail { order: -1; padding: 0 0 12px; border-left: 0; border-bottom: 1px solid var(--c-line); }

  .head { padding: 8px; }
  .head .brand-mark { margin-left: 8px; }
  .head .back, .head .close, button.ghost, .member-remove, .pending-attachment button { min-width: 44px; min-height: 44px; }
  .tab, button.primary, button.outline, .rm-follow, .member-role, .attachment { min-height: 44px; }
  .err-retry { position: relative; }
  .err-retry::after { content: ""; position: absolute; inset: -15px -4px; }
  .sw::before { content: ""; position: absolute; inset: -11px -3px; }
  .launcher::before { content: ""; position: absolute; inset: 0 0 0 -16px; }
  :host([data-edge="left"]) .launcher::before { inset: 0 -16px 0 0; }
}
@media (pointer: coarse) {
  input.field, textarea.field { font-size: 16px; }
}
` +
// Reduced motion: the shadow root can't see the dashboard's global backstop,
// so the widget carries its own. Nothing slides, scales or shimmers (the
// skeleton goes flat); state changes land at once.
`
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .skel { background: var(--c-surface-2); }
}
`;
