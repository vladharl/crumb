// Inline CSS injected into the widget's shadow root. Keeps Crumb's look
// without leaking onto the host page (and without being affected by it).
//
// Note on shadows: the dashboard's design principle is "no heavy shadows".
// The widget intentionally departs from this on the launcher + panel.
// The widget renders on arbitrary host pages (any background, any depth),
// so it needs real elevation to read as a separate surface. The shadow
// values below are tuned to be the *minimum* lift that survives across
// dark, light, and busy backgrounds. Don't soften further without testing
// against /widget-demo.html and at least one real host product.
//
// Note on tokens: colors are hardcoded hex (not CSS vars) because the
// widget mounts in a closed shadow root on a third-party page — it can't
// reach the dashboard's :root tokens. The values below MUST stay in sync
// with apps/dashboard/app/globals.css (--cream, --brown, --ember, --ink).
export const css = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }

.launcher {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 48px;
  height: 48px;
  border-radius: 999px;
  background: var(--crumb-launcher-bg);
  color: #FBF7F0;
  border: 1px solid rgba(0, 0, 0, 0.08);
  cursor: pointer;
  display: grid;
  place-items: center;
  /* Modern depth — Linear/Vercel/Stripe style. Three precision shadows,
     no halo, no specular. Reads as a real object resting just above the
     page without ever looking glossy. The hairline rim does the heavy
     lifting; the shadows are barely there. */
  box-shadow:
    0 1px 0 rgba(0, 0, 0, 0.04),
    0 2px 6px rgba(0, 0, 0, 0.08),
    0 8px 20px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  transition: transform 160ms ease, box-shadow 200ms ease, background 240ms ease;
  z-index: 2147483646;

  /* Per-instance brand colors — set by the widget from /me.workspace.{accent,launcher_bg}.
     Fallbacks match the dashboard's Swiss-spa palette so unbranded installs
     still look like Crumb. */
  --crumb-launcher-bg: #4A2E1F;
  --crumb-accent: #E27D3A;
}

/* The mark + workspace label + CTA inside the launcher. Hidden when the
   launcher is a corner circle; revealed when it morphs into top/inline. */
.launcher-name, .launcher-cta { display: none; }

/* ── top: full-width bar across the top of the host page ───────────── */
:host([data-pos="top"]) .launcher {
  top: 0; left: 0; right: 0; bottom: auto;
  width: 100%; height: 44px;
  border-radius: 0;
  padding: 0 18px;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 12px;
  /* Top variant: a single tight bottom shadow + hairline rim. Banner sits
     just above the page, no halo (would compete with the content below). */
  box-shadow:
    0 1px 0 rgba(0, 0, 0, 0.04),
    0 4px 12px rgba(0, 0, 0, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  border: 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
:host([data-pos="top"]) .launcher:hover {
  transform: none;
  box-shadow:
    0 1px 0 rgba(0, 0, 0, 0.06),
    0 6px 16px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
:host([data-pos="top"]) .launcher svg { width: 22px; height: 22px; }
:host([data-pos="top"]) .launcher-name {
  display: inline; flex: 1; min-width: 0;
  font-size: 13px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: left;
}
:host([data-pos="top"]) .launcher-cta {
  display: inline-block;
  padding: 4px 12px;
  border: 1px solid rgba(251, 247, 240, 0.4);
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.02em;
}

/* ── inline: docked bar centered at the bottom of the host page ──────
   Centered via left:0/right:0/margin-auto instead of transform, so the
   base transition on the transform property (used for hover lift) doesn't
   interpolate a translate during the data-pos handoff and visibly slide
   the button. */
:host([data-pos="inline"]) .launcher {
  left: 0; right: 0; bottom: 20px; top: auto;
  margin-inline: auto;
  width: max-content; max-width: calc(100vw - 40px);
  height: 44px;
  border-radius: 10px;
  padding: 0 14px;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
}
:host([data-pos="inline"]) .launcher svg { width: 22px; height: 22px; }
:host([data-pos="inline"]) .launcher-name {
  display: inline;
  font-size: 13px; font-weight: 500;
  white-space: nowrap;
}
:host([data-pos="inline"]) .launcher-cta {
  display: inline-block;
  margin-left: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(251, 247, 240, 0.16);
  font-size: 12px;
  letter-spacing: 0.02em;
}
.launcher:hover {
  transform: translateY(-1px);
  box-shadow:
    0 1px 0 rgba(0, 0, 0, 0.04),
    0 4px 10px rgba(0, 0, 0, 0.10),
    0 12px 28px rgba(0, 0, 0, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.10);
}
.launcher:active { transform: translateY(0); }
.launcher svg { width: 28px; height: 28px; overflow: visible; }
.launcher svg circle { fill: var(--crumb-accent); transition: fill 240ms ease; }

/* Boot pulse + settle are driven from JS via Motion One (see widget.ts).
   Animating in JS rather than CSS lets us use spring physics + staggered
   waves on SVG circles consistently across browsers — previous CSS-only
   attempts hit transform-box quirks under shadow DOM.
   prefers-reduced-motion is honored in the JS driver, not here. */

/* Attachments — rendered as a pill below each message body, and as
   pending-pills above the reply composer. Click downloads via the
   identity-aware /api/v1/uploads/[id] endpoint. */
.attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid rgba(28, 24, 21, 0.12);
  border-radius: 6px;
  background: #FFFFFF;
  text-decoration: none;
  color: #1C1815;
  font-size: 11px;
  max-width: 100%;
}
.attachment svg { width: 11px; height: 11px; opacity: 0.55; }
.attachment .filename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.attachment .size { font-size: 10px; color: #6B5C50; }
.attachment:hover { background: #FBF7F0; }

.pending-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 8px 6px;
}
.pending-attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 8px;
  border: 1px solid rgba(28, 24, 21, 0.12);
  border-radius: 6px;
  background: #FFFFFF;
  font-size: 11px;
}
.pending-attachment svg { width: 11px; height: 11px; opacity: 0.55; }
.pending-attachment .filename {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 160px;
}
.pending-attachment .size { font-size: 10px; color: #6B5C50; }
.pending-attachment button {
  background: none; border: 0; padding: 2px; cursor: pointer; color: #6B5C50;
}

.foot button.ghost {
  background: none;
  border: 1px solid rgba(28, 24, 21, 0.12);
  border-radius: 6px;
  padding: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #1C1815;
}
.foot button.ghost:disabled { opacity: 0.5; cursor: default; }
.foot button.ghost svg { width: 13px; height: 13px; }

.brand-mark { display: inline-flex; }
.brand-mark svg { width: 18px; height: 18px; }
.brand-mark svg circle { fill: #E27D3A; }

.badge {
  position: absolute;
  top: -4px; right: -4px;
  min-width: 18px; height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #E27D3A;
  color: #FBF7F0;
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #4A2E1F;
}

.tooltip {
  position: fixed;
  right: 76px;
  bottom: 30px;
  background: #1C1815;
  color: #FBF7F0;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  letter-spacing: 0.02em;
  pointer-events: none;
  opacity: 0;
  transform: translateX(6px);
  transition: opacity 140ms ease, transform 140ms ease;
  z-index: 2147483645;
  white-space: nowrap;
}
.launcher:hover ~ .tooltip { opacity: 1; transform: translateX(0); }
/* Only the corner circle needs a tooltip — the bar variants carry their own
   label. Suppress the floating tooltip in those modes so it doesn't show
   alongside the CTA. */
:host([data-pos="top"]) .tooltip,
:host([data-pos="inline"]) .tooltip { display: none; }

.panel {
  position: fixed;
  right: 20px;
  bottom: 80px;
  width: 380px;
  max-width: calc(100vw - 40px);
  height: 600px;
  max-height: calc(100vh - 100px);
  background: #FBF7F0;
  border: 1px solid rgba(28, 24, 21, 0.12);
  border-radius: 14px;
  box-shadow: 0 24px 56px rgba(28, 24, 21, 0.22), 0 2px 6px rgba(28, 24, 21, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
  transition: opacity 160ms ease, transform 160ms ease, width 220ms ease, height 220ms ease, right 220ms ease, bottom 220ms ease;
  z-index: 2147483647;
}
.panel.open {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

/* Panel anchoring per position. The expanded mode (below) overrides these
   when the user pops the panel out of corner mode. */
:host([data-pos="top"]) .panel {
  top: 56px; bottom: auto; right: 12px;
  transform: translateY(-8px);
}
:host([data-pos="top"]) .panel.open { transform: translateY(0); }
:host([data-pos="inline"]) .panel {
  left: 50%; right: auto; bottom: 76px;
  transform: translate(-50%, 8px);
}
:host([data-pos="inline"]) .panel.open { transform: translate(-50%, 0); }

/* Expanded mode — fills more of the host page for long threads.
   Triggered from the thread view's expand button. */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(28, 24, 21, 0.55);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
  z-index: 2147483646;
}
.scrim.show {
  opacity: 1;
  pointer-events: auto;
}
.panel.expanded {
  right: 50%;
  bottom: 50%;
  transform: translate(50%, 50%);
  width: min(760px, calc(100vw - 48px));
  height: min(720px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
  border-radius: 12px;
}
.panel.expanded.open {
  transform: translate(50%, 50%);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 14px 10px;
  border-bottom: 1px solid rgba(28, 24, 21, 0.08);
}
.head .back, .head .close {
  appearance: none; background: transparent; border: 0;
  width: 28px; height: 28px; border-radius: 6px;
  display: grid; place-items: center; cursor: pointer; color: #6B5C50;
}
.head .back:hover, .head .close:hover { background: rgba(28, 24, 21, 0.06); color: #1C1815; }
.head .title { font-weight: 600; color: #1C1815; font-size: 14px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .sub { font-size: 11px; color: #8A7C70; }
.head svg { width: 16px; height: 16px; }


.body {
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: #1C1815;
  flex: 1;
}

.lede {
  font-size: 13px;
  line-height: 1.5;
  color: #6B5C50;
  margin: 0 0 4px;
}

/* ── list view ────────────────────────────────── */
.items-list { display: flex; flex-direction: column; gap: 6px; }
.item-row {
  appearance: none;
  text-align: left;
  background: transparent;
  border: 1px solid rgba(28, 24, 21, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 6px;
  transition: background 100ms ease, border-color 100ms ease;
}
.item-row:hover { background: rgba(28, 24, 21, 0.03); border-color: rgba(28, 24, 21, 0.16); }
.item-row .top { display: flex; align-items: center; gap: 8px; }
.item-row .short { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 10px; color: #8A7C70; }
.item-row .age { margin-left: auto; font-size: 10px; color: #8A7C70; font-family: ui-monospace, monospace; }
.item-row .title { font-size: 13px; color: #1C1815; font-weight: 500; line-height: 1.4; word-wrap: break-word; }
.item-row .bottom { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #6B5C50; }

.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 7px; border-radius: 999px;
  border: 1px solid rgba(28, 24, 21, 0.16);
  font-size: 11px; color: #4A2E1F;
}
.status-dot { width: 7px; height: 7px; border-radius: 999px; background: #C2B7A8; display: inline-block; }
.status-dot.review { background: #C2B7A8; box-shadow: inset 0 0 0 1.5px #4A2E1F; }
.status-dot.planned { background: #DCC9B6; }
.status-dot.progress { background: #B89878; }
.status-dot.shipped { background: #6B8E5B; }
.status-dot.declined { background: #B43C3C; }
.status-dot.deferred { background: #C99340; }
.status-dot.duplicate { background: transparent; border: 1.5px dashed #8A7C70; box-sizing: content-box; width: 4px; height: 4px; }

.empty {
  text-align: center;
  padding: 24px 12px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  /* Auto vertical margins center it within the flex-column .body so the
     submit confirmation doesn't hug the top of a tall panel. */
  margin: auto 0;
}
.empty .icon {
  width: 36px; height: 36px;
  border-radius: 999px;
  background: rgba(226, 125, 58, 0.12);
  color: #E27D3A;
  display: grid; place-items: center;
}
.empty h2 { margin: 4px 0 0; font-size: 17px; font-weight: 600; color: #1C1815; letter-spacing: -0.01em; }
.empty p { margin: 0; font-size: 13px; line-height: 1.55; color: #6B5C50; max-width: 30ch; }

/* ── compose view ─────────────────────────────── */
.types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.type-btn {
  appearance: none;
  background: transparent;
  border: 1px solid rgba(28, 24, 21, 0.12);
  border-radius: 8px;
  padding: 8px 6px;
  font-size: 12px;
  color: #4A2E1F;
  cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  transition: background 120ms ease, border-color 120ms ease;
}
.type-btn:hover { background: rgba(28, 24, 21, 0.04); }
.type-btn[aria-pressed="true"] {
  border-color: #E27D3A;
  background: rgba(226, 125, 58, 0.08);
  color: #1C1815;
}
.type-btn svg { width: 14px; height: 14px; }

input.field, textarea.field {
  appearance: none;
  width: 100%;
  background: transparent;
  border: 1px solid rgba(28, 24, 21, 0.12);
  border-radius: 8px;
  padding: 9px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  color: #1C1815;
  resize: vertical;
}
input.field:focus, textarea.field:focus { outline: none; border-color: #4A2E1F; }
textarea.field { min-height: 72px; }
.field-label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6B5C50;
  display: block;
  margin-bottom: 4px;
}

.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }

button.primary {
  appearance: none;
  background: #1C1815;
  color: #FBF7F0;
  border: 0;
  padding: 9px 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: opacity 120ms ease;
}
button.primary:hover { opacity: 0.92; }
button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary svg { width: 12px; height: 12px; }

button.ghost {
  appearance: none; background: transparent; border: 0;
  font: inherit; font-size: 12px; color: #6B5C50; cursor: pointer; padding: 4px 6px;
}
button.ghost:hover { color: #1C1815; }

button.outline {
  appearance: none; background: transparent;
  border: 1px solid rgba(28, 24, 21, 0.16);
  border-radius: 8px; padding: 8px 12px;
  font: inherit; font-size: 12px; color: #1C1815; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background 120ms ease;
}
button.outline:hover { background: rgba(28, 24, 21, 0.04); }
button.outline svg { width: 12px; height: 12px; }

/* ── thread view ──────────────────────────────── */
.msg {
  border: 1px solid rgba(28, 24, 21, 0.08);
  border-radius: 10px;
  padding: 10px 12px;
  background: #FFFBF3;
}
.msg.vendor { background: #1C1815; color: #FBF7F0; border-color: transparent; }
.msg .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; opacity: 0.8; }
.msg.vendor .meta { color: #DCC9B6; }
.msg .avatar {
  width: 22px; height: 22px; border-radius: 999px;
  background: #4A2E1F; color: #FBF7F0;
  display: grid; place-items: center; font-size: 10px; font-weight: 600;
}
.msg.vendor .avatar { background: #E27D3A; color: #1C1815; }
.msg p { margin: 0; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }

.thread-meta {
  font-size: 11px; color: #6B5C50;
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed rgba(28, 24, 21, 0.12);
  margin-bottom: 4px;
}

/* ── footer ───────────────────────────────────── */
.foot {
  padding: 10px 14px 12px;
  border-top: 1px solid rgba(28, 24, 21, 0.08);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.foot .meta { font-size: 11px; color: #8A7C70; flex: 1; }
.foot .row { display: flex; gap: 8px; align-items: center; }

.err {
  background: rgba(180, 60, 60, 0.08);
  border: 1px solid rgba(180, 60, 60, 0.25);
  color: #8a3a3a;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}

.spinner {
  width: 16px; height: 16px;
  border-radius: 999px;
  border: 2px solid rgba(28, 24, 21, 0.15);
  border-top-color: #4A2E1F;
  animation: spin 700ms linear infinite;
  margin: 18px auto;
}
@keyframes spin { to { transform: rotate(360deg); } }

.short-id {
  font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  font-size: 11px;
  color: #6B5C50;
}

/* ── tabs (top of body, list ↔ admin) ──────────────────── */
.tabs {
  display: inline-flex;
  background: rgba(28, 24, 21, 0.04);
  border: 1px solid rgba(28, 24, 21, 0.08);
  border-radius: 999px;
  padding: 3px;
  gap: 2px;
  align-self: flex-start;
}
.tab {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  color: #6B5C50;
  cursor: pointer;
  border-radius: 999px;
  transition: background 100ms ease, color 100ms ease;
}
.tab:hover { color: #1C1815; }
.tab[aria-selected="true"] {
  background: #FBF7F0;
  color: #1C1815;
  box-shadow: 0 1px 2px rgba(28, 24, 21, 0.06);
}

/* ── admin tab content ─────────────────────────────────── */
.admin-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(28, 24, 21, 0.08);
  border-radius: 10px;
  background: #FFFBF3;
}
.admin-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.admin-card-title {
  font-weight: 600;
  font-size: 13px;
  color: #1C1815;
  flex: 1;
}
.admin-card-sub {
  font-size: 11px;
  color: #8A7C70;
}

.badge-inline {
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #6B5C50;
  padding: 2px 7px;
  border: 1px solid rgba(28, 24, 21, 0.14);
  border-radius: 999px;
  background: rgba(226, 125, 58, 0.06);
}

.members {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.member-avatar {
  width: 26px; height: 26px;
  border-radius: 999px;
  background: #4A2E1F;
  color: #FBF7F0;
  display: grid; place-items: center;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
.member-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.member-name {
  font-size: 13px;
  color: #1C1815;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}
.member-you {
  font-size: 10px;
  color: #8A7C70;
  font-weight: 400;
  background: rgba(28, 24, 21, 0.05);
  padding: 1px 6px;
  border-radius: 999px;
}
.member-email {
  font-size: 11px;
  color: #8A7C70;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.role-pill {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: #4A2E1F;
  background: rgba(226, 125, 58, 0.14);
  padding: 2px 8px;
  border-radius: 999px;
}
.member-count {
  font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  font-size: 11px;
  color: #6B5C50;
  min-width: 18px;
  text-align: right;
}

.text-sm { font-size: 13px; }
.muted { color: #6B5C50; }

/* ── thread layout (single column collapsed, two-column expanded) ── */
.thread-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.thread-messages {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.status-rail { display: none; }

.panel.expanded .thread-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 200px;
  gap: 24px;
  align-items: start;
}
.panel.expanded .status-rail {
  display: block;
  padding-left: 16px;
  border-left: 1px solid rgba(28, 24, 21, 0.08);
}

.rail-heading {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #8A7C70;
  font-weight: 600;
  margin-bottom: 10px;
}
.event {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}
.event-dot { width: 8px; height: 8px; border-radius: 999px; }
.event-label { font-size: 12px; color: #1C1815; }
.event-age {
  font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  font-size: 10px; color: #8A7C70;
}
.event-reason {
  grid-column: 2 / -1;
  font-size: 11px;
  line-height: 1.5;
  color: #6B5C50;
  font-style: italic;
  padding: 4px 0 2px;
  border-left: 1px solid rgba(28, 24, 21, 0.12);
  padding-left: 8px;
  margin-left: -2px;
  margin-top: 2px;
}

/* The open status has no fill — hollow circle */
.status-dot.open {
  background: transparent;
  border: 1.5px solid #4A2E1F;
  box-sizing: content-box;
  width: 5px; height: 5px;
}
`;
