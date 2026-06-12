// Inline CSS injected into the widget's shadow root. Keeps Crumb's look
// without leaking onto the host page (and without being affected by it).
//
// Design: Crumb's warm palette (cream + toasted brown, ember as the single
// accent), matching the dashboard's globals.css. Only the launcher keeps the
// workspace's chosen brand color (set per-instance from /me via
// --crumb-launcher-bg / --crumb-accent). Tokens are defined on :host so the
// whole widget is tunable from one place.
//
// On shadows: the widget renders on arbitrary host pages, so it needs real
// elevation to read as a separate surface. The values below are the minimum
// lift that survives across light/dark/busy backgrounds (warm-brown tinted to
// match the dashboard); soften only after testing /widget-demo.html against a
// real host product.
export const css = `
:host {
  all: initial;

  /* ── warm palette (matches dashboard globals.css) ── */
  --c-bg: #FBF7F0;
  --c-surface-2: #F4EEE2;
  --c-ink: #4A2E1F;
  --c-ink-2: #6A4528;
  --c-ink-3: #8A8278;
  --c-line: rgba(74, 46, 31, 0.10);
  --c-line-2: rgba(74, 46, 31, 0.16);

  /* ── single accent (ember) ── */
  --c-accent: #E27D3A;
  --c-accent-ink: #B65E22;
  --c-accent-soft: rgba(226, 125, 58, 0.10);

  /* ── radii / motion ── */
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 14px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);

  /* per-instance brand color for the launcher (set by JS from /me); the
     neutral default below is only for unbranded installs. */
  --crumb-launcher-bg: #1C1A17;
  --crumb-accent: #E27D3A;
}
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }

/* ── launcher: the edge whisper tab ─────────────────────────
   A slim flat tab docked flush to a viewport edge, vertically centered.
   Borders-only depth — no blur, no gloss, one hairline shadow. It earns
   presence only when there's loop news (.l-dot + 2px of width); hovering
   or focusing slides a small flat flag out with the latest event. */
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
  border-radius: 8px 0 0 8px;
  box-shadow: 0 1px 2px rgba(74, 46, 31, 0.08);
  cursor: pointer;
  transition: width 200ms cubic-bezier(0.25, 1, 0.5, 1), background 200ms cubic-bezier(0.25, 1, 0.5, 1);
  z-index: 2147483646;
}
:host([data-edge="left"]) .launcher {
  left: 0; right: auto;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
  border-left: 0;
  border-radius: 0 8px 8px 0;
}
.launcher[data-state="news"] { width: 30px; }
.launcher:hover, .launcher:focus-visible { width: 32px; }
.launcher:focus-visible { outline: 2px solid var(--crumb-accent); outline-offset: 2px; }

.launcher .l-mark { display: inline-flex; }
.launcher .l-mark svg { width: 16px; height: 16px; overflow: visible; }
/* The loop mark is the brand "dot color" (configurable in Branding) — same in
   the dashboard preview, so what a vendor sets is what their customers see. */
.launcher svg circle { fill: var(--crumb-accent); transition: fill 240ms var(--ease); }

.launcher .l-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  /* Follows the dot color so one branding choice controls everything on the
     tab — and the Branding contrast warning (dot vs launcher bg) covers the
     label's readability too. */
  color: var(--crumb-accent);
  user-select: none;
}

/* Loop-news dot: ember, static — restraint over pulse. */
.launcher .l-dot {
  width: 6px; height: 6px;
  border-radius: 999px;
  background: var(--crumb-accent);
}
.launcher .l-dot[hidden] { display: none; }

/* The flag: a flat paper card that slides out beside the tab on hover/focus
   with the latest loop event ("Maya replied · 2" / "Shipped: Dark mode").
   Part of the button, so it stays open under the cursor and clicks through. */
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
  border-radius: var(--r-sm);
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
.launcher .l-flag-count { color: var(--c-accent-ink); font-weight: 600; }
.launcher .l-flag-count:empty { display: none; }

@media (prefers-reduced-motion: reduce) {
  .launcher, .launcher .l-flag, .launcher svg circle { transition: none; }
}

/* ── attachments ── */
.attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid var(--c-line-2);
  border-radius: 8px;
  background: var(--c-bg);
  text-decoration: none;
  color: var(--c-ink);
  font-size: 11px;
  max-width: 100%;
}
.attachment svg { width: 11px; height: 11px; opacity: 0.55; }
.attachment .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.attachment .size { font-size: 10px; color: var(--c-ink-3); }
.attachment:hover { background: var(--c-surface-2); }

.pending-attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 8px 6px; }
.pending-attachment {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 4px 5px 9px;
  border: 1px solid var(--c-line-2);
  border-radius: 8px;
  background: var(--c-bg);
  font-size: 11px;
}
.pending-attachment svg { width: 11px; height: 11px; opacity: 0.55; }
.pending-attachment .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
.pending-attachment .size { font-size: 10px; color: var(--c-ink-3); }
.pending-attachment button { background: none; border: 0; padding: 2px; cursor: pointer; color: var(--c-ink-3); }

.foot button.ghost {
  background: none;
  border: 1px solid var(--c-line-2);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--c-ink);
  transition: background 120ms var(--ease);
}
.foot button.ghost:hover { background: var(--c-surface-2); }
.foot button.ghost:disabled { opacity: 0.5; cursor: default; }
.foot button.ghost svg { width: 14px; height: 14px; }

.brand-mark { display: inline-flex; }
.brand-mark svg { width: 18px; height: 18px; }
.brand-mark svg circle { fill: var(--c-accent); }

.panel {
  position: fixed;
  /* Anchored beside the edge tab: vertically centered on the same nudge the
     launcher tracks, a small inset off the edge. */
  right: 16px;
  top: calc(50% + var(--crumb-offset-y, 0px));
  width: 392px;
  max-width: calc(100vw - 40px);
  height: 620px;
  max-height: calc(100vh - 32px);
  background: var(--c-bg);
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
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
  max-height: calc(100vh - 48px);
  border-radius: var(--r-lg);
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
  width: 30px; height: 30px; border-radius: 8px;
  display: grid; place-items: center; cursor: pointer; color: var(--c-ink-2);
  transition: background 120ms var(--ease), color 120ms var(--ease);
}
.head .back:hover, .head .close:hover { background: var(--c-surface-2); color: var(--c-ink); }
.head .title { font-weight: 600; color: var(--c-ink); font-size: 15px; letter-spacing: -0.01em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .sub { font-size: 12px; color: var(--c-ink-3); }
.head svg { width: 16px; height: 16px; }

.body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--c-ink);
  flex: 1;
}

.lede { font-size: 13.5px; line-height: 1.55; color: var(--c-ink-2); margin: 0 0 2px; }

/* ── list view ── */
.items-list { display: flex; flex-direction: column; gap: 8px; }
.item-row {
  appearance: none;
  text-align: left;
  background: var(--c-bg);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  padding: 13px 14px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 7px;
  transition: background 120ms var(--ease), border-color 120ms var(--ease), transform 120ms var(--ease);
}
.item-row:hover { background: var(--c-surface-2); border-color: var(--c-line-2); }
.item-row:active { transform: scale(0.995); }
.item-row .top { display: flex; align-items: center; gap: 8px; }
.item-row .short { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--c-ink-3); }
.item-row .age { margin-left: auto; font-size: 10.5px; color: var(--c-ink-3); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.item-row .title { font-size: 13.5px; color: var(--c-ink); font-weight: 500; line-height: 1.45; word-wrap: break-word; }
.item-row .bottom { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-ink-2); }

.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 8px; border-radius: 999px;
  border: 1px solid var(--c-line-2);
  font-size: 11px; color: var(--c-ink-2);
}
.status-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--c-ink-3); display: inline-block; }
.status-dot.review { background: var(--c-ink-3); box-shadow: inset 0 0 0 1.5px var(--c-ink); }
.status-dot.planned { background: #6E8BD6; }
.status-dot.progress { background: #C7913C; }
.status-dot.shipped { background: #4E9E6A; }
.status-dot.declined { background: #C7544E; }
.status-dot.deferred { background: #9AA0AA; }
.status-dot.duplicate { background: transparent; border: 1.5px dashed var(--c-ink-3); box-sizing: content-box; width: 4px; height: 4px; }

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
.empty h2 { margin: 2px 0 0; font-size: 18px; font-weight: 600; color: var(--c-ink); letter-spacing: -0.015em; }
.empty p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--c-ink-2); max-width: 32ch; }

/* ── compose view ── */
.types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.type-btn {
  appearance: none;
  background: var(--c-bg);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-sm);
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

input.field, textarea.field {
  appearance: none;
  width: 100%;
  background: var(--c-bg);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  font: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--c-ink);
  resize: vertical;
  transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
}
input.field::placeholder, textarea.field::placeholder { color: var(--c-ink-3); }
input.field:focus, textarea.field:focus {
  outline: none;
  border-color: var(--c-accent);
  box-shadow: 0 0 0 3px var(--c-accent-soft);
}
textarea.field { min-height: 84px; }
.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--c-ink-2);
  display: block;
  margin-bottom: 6px;
}

.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }

button.primary {
  appearance: none;
  background: var(--c-ink);
  color: #FFFFFF;
  border: 0;
  padding: 10px 16px;
  border-radius: var(--r-sm);
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: transform 120ms var(--ease), opacity 120ms var(--ease), box-shadow 120ms var(--ease);
}
button.primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(74, 46, 31, 0.16); }
button.primary:active { transform: translateY(0); }
button.primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
button.primary svg { width: 13px; height: 13px; }

button.ghost {
  appearance: none; background: transparent; border: 0;
  font: inherit; font-size: 12.5px; color: var(--c-ink-2); cursor: pointer; padding: 6px 8px; border-radius: 8px;
  transition: background 120ms var(--ease), color 120ms var(--ease);
}
button.ghost:hover { color: var(--c-ink); background: var(--c-surface-2); }

button.outline {
  appearance: none; background: var(--c-bg);
  border: 1px solid var(--c-line-2);
  border-radius: var(--r-sm); padding: 9px 13px;
  font: inherit; font-size: 12.5px; color: var(--c-ink); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background 120ms var(--ease);
}
button.outline:hover { background: var(--c-surface-2); }
button.outline svg { width: 13px; height: 13px; }

/* ── thread view ── */
.msg {
  border: 1px solid var(--c-line);
  border-radius: 14px;
  padding: 11px 13px;
  background: var(--c-surface-2);
}
.msg.vendor { background: var(--c-ink); color: #FFFFFF; border-color: transparent; }
.msg .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 11px; color: var(--c-ink-3); }
.msg.vendor .meta { color: rgba(255, 255, 255, 0.6); }
.msg .meta .when { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.msg .avatar {
  width: 24px; height: 24px; border-radius: 999px;
  background: var(--c-line-2); color: var(--c-ink);
  display: grid; place-items: center; font-size: 10px; font-weight: 600;
}
.msg.vendor .avatar { background: var(--c-accent); color: #FFFFFF; }
.msg p { margin: 0; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; }

.thread-meta {
  font-size: 11px; color: var(--c-ink-2);
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--c-line);
  margin-bottom: 2px;
}

/* ── footer ── */
.foot {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--c-line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.foot .meta { font-size: 11px; color: var(--c-ink-3); flex: 1; }
.foot .row { display: flex; gap: 8px; align-items: center; }

.err {
  background: rgba(199, 84, 78, 0.08);
  border: 1px solid rgba(199, 84, 78, 0.22);
  color: #B23A34;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
}

/* ── skeleton loaders (replace the old spinner) ── */
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skel {
  border-radius: var(--r-md);
  background: linear-gradient(100deg, var(--c-surface-2) 30%, rgba(20,22,27,0.05) 50%, var(--c-surface-2) 70%);
  background-size: 220% 100%;
  animation: crumb-shimmer 1.3s var(--ease) infinite;
}
.skel.row { height: 58px; }
.skel.line { height: 12px; }
.skel.line.short { width: 45%; }
@keyframes crumb-shimmer { from { background-position: 180% 0; } to { background-position: -40% 0; } }
@media (prefers-reduced-motion: reduce) { .skel { animation: none; } }

/* legacy spinner — kept subtle as a fallback */
.spinner {
  width: 18px; height: 18px;
  border-radius: 999px;
  border: 2px solid var(--c-line-2);
  border-top-color: var(--c-ink-2);
  animation: spin 700ms linear infinite;
  margin: 18px auto;
}
@keyframes spin { to { transform: rotate(360deg); } }

.short-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--c-ink-2);
}

/* ── tabs (underline style) ── */
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
  color: var(--c-ink-3);
  cursor: pointer;
  transition: color 120ms var(--ease), border-color 120ms var(--ease);
}
.tab:hover { color: var(--c-ink-2); }
.tab[aria-selected="true"] {
  color: var(--c-ink);
  border-bottom-color: var(--c-accent);
}

/* ── admin tab content ── */
.admin-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px;
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
}
.admin-card-head { display: flex; align-items: center; gap: 8px; }
.admin-card-title { font-weight: 600; font-size: 13px; color: var(--c-ink); flex: 1; }
.admin-card-sub { font-size: 11px; color: var(--c-ink-3); }

.badge-inline {
  font-size: 10px;
  font-weight: 500;
  color: var(--c-accent-ink);
  padding: 2px 8px;
  border: 1px solid var(--c-line-2);
  border-radius: 999px;
  background: var(--c-accent-soft);
}

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
.member-email { font-size: 11px; color: var(--c-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

/* ── member management controls (admins) ── */
.member-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.member-role {
  font-size: 11px; font-weight: 500; color: var(--c-ink-2);
  background: var(--c-surface-2); border: 1px solid var(--c-line);
  padding: 3px 9px; border-radius: 999px; cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.member-role:hover { background: var(--c-bg); color: var(--c-ink); border-color: var(--c-line-2); }
.member-remove {
  width: 26px; height: 26px; border-radius: 8px;
  background: none; border: 0; cursor: pointer; color: var(--c-ink-3);
  display: grid; place-items: center;
}
.member-remove svg { width: 14px; height: 14px; }
.member-remove:hover { background: var(--c-surface-2); color: #B42318; }
.role-pill.ghost { color: var(--c-ink-3); background: var(--c-surface-2); }

/* ── notification settings (toggle switches) ── */
.set-row { display: flex; align-items: center; gap: 12px; padding: 11px 0; }
.set-row + .set-row { border-top: 1px solid var(--c-line); }
.set-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.set-label { font-size: 13.5px; font-weight: 500; color: var(--c-ink); }
.set-sub { font-size: 11.5px; color: var(--c-ink-3); line-height: 1.4; }
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
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 160ms var(--ease);
}
.sw.on { background: var(--c-accent); }
.sw.on::after { transform: translateX(16px); }
.sw:disabled { cursor: default; }

.text-sm { font-size: 13px; }
.muted { color: var(--c-ink-2); }

/* ── thread layout (single column collapsed, two-column expanded) ── */
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

.rail-heading {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--c-ink-3);
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
.event-age {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; color: var(--c-ink-3);
}
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

/* open status has no fill — hollow circle */
.status-dot.open {
  background: transparent;
  border: 1.5px solid var(--c-ink-2);
  box-sizing: content-box;
  width: 5px; height: 5px;
}

/* ── roadmap view (customer-facing Now/Next/Later) ── */
.rm-board { display: flex; flex-direction: column; gap: 18px; }
.rm-col { display: flex; flex-direction: column; gap: 8px; }
.rm-col-head {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--c-ink-3);
}
.rm-card {
  border: 1px solid var(--c-line); border-radius: var(--r-md);
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
`;
