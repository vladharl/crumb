// Inline CSS injected into the widget's shadow root. Keeps Crumb's look
// without leaking onto the host page (and without being affected by it).
//
// Design: a clean, neutral surface with ember as the single accent. The
// panel chrome is intentionally palette-neutral (near-white + near-black +
// grays); only the launcher keeps the workspace's chosen brand color (set
// per-instance from /me via --crumb-launcher-bg / --crumb-accent). Tokens are
// defined on :host so the whole widget is tunable from one place.
//
// NOTE: this palette intentionally diverges from the dashboard's warm
// globals.css — the widget was modernized to a neutral look first; the
// dashboard can follow later.
//
// On shadows: the widget renders on arbitrary host pages, so it needs real
// elevation to read as a separate surface. The values below are the minimum
// lift that survives across light/dark/busy backgrounds — soften only after
// testing /widget-demo.html against a real host product.
export const css = `
:host {
  all: initial;

  /* ── neutral palette ── */
  --c-bg: #FFFFFF;
  --c-surface-2: #F5F6F8;
  --c-ink: #15171B;
  --c-ink-2: #51555E;
  --c-ink-3: #8A8F98;
  --c-line: rgba(20, 22, 27, 0.08);
  --c-line-2: rgba(20, 22, 27, 0.14);

  /* ── single accent (ember) ── */
  --c-accent: #E27D3A;
  --c-accent-ink: #B65E22;
  --c-accent-soft: rgba(226, 125, 58, 0.10);

  /* ── radii / motion ── */
  --r-sm: 10px;
  --r-md: 12px;
  --r-lg: 18px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);

  /* per-instance brand color for the launcher (set by JS from /me); the
     neutral default below is only for unbranded installs. */
  --crumb-launcher-bg: #1C1A17;
  --crumb-accent: #E27D3A;
}
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }

.launcher {
  position: fixed;
  /* Base 20px corner inset + an optional offset so the launcher can stack
     above another widget's bubble (corner/pill positions; the tab variant
     docks to the edge and ignores the offset). */
  right: calc(20px + var(--crumb-offset-x, 0px));
  bottom: calc(20px + var(--crumb-offset-y, 0px));
  width: 54px;
  height: 54px;
  border-radius: 50%;
  /* Flat "liquid glass": a translucent fill + backdrop blur gives the frosted
     glass quality (the page shows through, slightly muted), a hairline rim
     catches light, and a soft flat elevation shadow lifts it. No 3D gradient /
     bevel — matte and modern. Stays legible on light pages at this opacity;
     the opt-in .glass variant pushes the frost further. */
  background: color-mix(in srgb, var(--crumb-launcher-bg) 82%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(0.95);
  backdrop-filter: blur(14px) saturate(0.95);
  color: #FFFFFF;
  border: 1px solid rgba(255, 255, 255, 0.10);
  cursor: pointer;
  display: grid;
  place-items: center;
  box-shadow:
    0 1px 2px rgba(16, 18, 23, 0.12),
    0 6px 18px rgba(16, 18, 23, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  transition: transform 220ms cubic-bezier(0.34, 1.4, 0.5, 1), box-shadow 200ms var(--ease), background 240ms var(--ease);
  z-index: 2147483646;
}
/* whisper-thin top sheen — the single glass highlight, kept flat */
.launcher::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0) 40%);
}
.launcher > svg, .launcher .launcher-cta, .launcher .launcher-name { position: relative; z-index: 1; }

/* The mark + label/CTA inside the launcher. Hidden for the corner circle;
   revealed for the pill + tab variants. */
.launcher-name, .launcher-cta { display: none; }

/* ── pill: rounded, labeled button (bottom-right) ── */
:host([data-pos="pill"]) .launcher {
  width: auto; height: 48px;
  border-radius: 999px;
  padding: 0 18px 0 15px;
  display: flex; justify-content: flex-start; align-items: center; gap: 9px;
}
:host([data-pos="pill"]) .launcher svg { width: 20px; height: 20px; }
:host([data-pos="pill"]) .launcher-cta {
  display: inline-block; font-size: 14px; font-weight: 500; white-space: nowrap;
}

/* ── tab: slim vertical bar docked to the right edge ── */
:host([data-pos="tab"]) .launcher {
  right: 0; left: auto; bottom: auto; top: 50%;
  transform: translateY(-50%);
  width: auto; height: auto;
  border-radius: 12px 0 0 12px;
  padding: 15px 8px;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}
:host([data-pos="tab"]) .launcher svg { width: 20px; height: 20px; }
:host([data-pos="tab"]) .launcher-cta {
  display: inline-block; writing-mode: vertical-rl;
  font-size: 13px; font-weight: 500; letter-spacing: 0.02em;
}
:host([data-pos="tab"]) .launcher:hover { transform: translateY(-50%) scale(1.04); }
:host([data-pos="tab"]) .launcher:active { transform: translateY(-50%) scale(0.97); }

/* springy hover / press (corner + pill) */
.launcher:hover {
  transform: translateY(-2px) scale(1.04);
  box-shadow:
    0 2px 4px rgba(16, 18, 23, 0.14),
    0 12px 28px rgba(16, 18, 23, 0.20),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.launcher:active { transform: translateY(0) scale(0.97); }
.launcher svg { width: 24px; height: 24px; overflow: visible; }
/* The loop mark is the brand "dot color" (configurable in Branding) — same in
   the dashboard preview, so what a vendor sets is what their customers see. */
.launcher svg circle { fill: var(--crumb-accent); transition: fill 240ms var(--ease); }

/* opt-in glassmorphism: pushes the frost further — more translucent + heavier
   blur — for busy or dark host pages. Same flat treatment, no gloss. */
.launcher.glass {
  background: color-mix(in srgb, var(--crumb-launcher-bg) 62%, transparent);
  backdrop-filter: blur(18px) saturate(1.5);
  -webkit-backdrop-filter: blur(18px) saturate(1.5);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow:
    0 1px 2px rgba(16, 18, 23, 0.10),
    0 8px 24px rgba(16, 18, 23, 0.14),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
}

/* Boot pulse + settle are driven from JS via Motion One (see widget.ts).
   prefers-reduced-motion is honored in the JS driver. */

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

/* Unread = a small pulsing attention dot (count lives in the list). The
   double ring uses box-shadow so it works on any launcher background. */
.badge {
  position: absolute;
  top: 1px; right: 1px;
  width: 11px; height: 11px;
  border-radius: 999px;
  background: var(--c-accent);
  border: 2px solid var(--crumb-launcher-bg);
  box-shadow: 0 0 0 0 var(--c-accent);
  animation: crumb-pulse 1.8s var(--ease) infinite;
}
:host([data-pos="tab"]) .badge { top: -3px; right: -3px; }
@keyframes crumb-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(226, 125, 58, 0.45); }
  70%  { box-shadow: 0 0 0 7px rgba(226, 125, 58, 0); }
  100% { box-shadow: 0 0 0 0 rgba(226, 125, 58, 0); }
}
@media (prefers-reduced-motion: reduce) { .badge { animation: none; } }

.tooltip {
  position: fixed;
  right: 80px;
  bottom: 32px;
  background: var(--c-ink);
  color: #FFFFFF;
  padding: 7px 11px;
  border-radius: 8px;
  font-size: 12px;
  pointer-events: none;
  opacity: 0;
  transform: translateX(6px);
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
  z-index: 2147483645;
  white-space: nowrap;
}
.launcher:hover ~ .tooltip { opacity: 1; transform: translateX(0); }
:host([data-pos="pill"]) .tooltip,
:host([data-pos="tab"]) .tooltip { display: none; }

.panel {
  position: fixed;
  /* Track the launcher's offset so the panel stays anchored to the bubble. */
  right: calc(20px + var(--crumb-offset-x, 0px));
  bottom: calc(84px + var(--crumb-offset-y, 0px));
  width: 392px;
  max-width: calc(100vw - 40px);
  height: 620px;
  max-height: calc(100vh - 110px);
  background: var(--c-bg);
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
  box-shadow:
    0 1px 2px rgba(16, 18, 23, 0.04),
    0 4px 12px rgba(16, 18, 23, 0.06),
    0 16px 40px rgba(16, 18, 23, 0.14);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transform: translateY(10px) scale(0.985);
  transform-origin: bottom right;
  pointer-events: none;
  transition: opacity 180ms var(--ease), transform 220ms var(--ease), width 220ms var(--ease), height 220ms var(--ease), right 220ms var(--ease), bottom 220ms var(--ease);
  z-index: 2147483647;
}
.panel.open {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}

/* pill + tab both anchor the panel bottom-right (base rules above); the tab
   launcher sits mid-right-edge and the panel opens below it. */

.scrim {
  position: fixed;
  inset: 0;
  background: rgba(16, 18, 23, 0.40);
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
  bottom: 50%;
  transform: translate(50%, 50%);
  width: min(780px, calc(100vw - 48px));
  height: min(720px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
  border-radius: var(--r-lg);
}
.panel.expanded.open { transform: translate(50%, 50%); }

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
button.primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16, 18, 23, 0.16); }
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
