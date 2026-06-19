---
name: Crumb
description: The feedback loop for product teams — warm, attentive, quietly confident. Follow the trail.
colors:
  ember: "#E27D3A"
  ember-soft: "#FCE9D6"
  ember-deep: "#B45F23"
  brown: "#4A2E1F"
  brown-2: "#6A4528"
  cream: "#FBF7F0"
  cream-soft: "#FDFAF4"
  cream-2: "#F4EEE2"
  oat-deep: "#1A1815"
  warm-gray: "#8A8278"
  green: "#6B8E5A"
  green-soft: "#E8EFE0"
  amber: "#D4A24C"
  amber-soft: "#F8EFD5"
  rust: "#B3573A"
  rust-soft: "#F3DBCE"
  rust-deep: "#8A3A3A"
typography:
  display:
    fontFamily: "General Sans, GT Walsheim, Söhne, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "General Sans, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "General Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.14em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "0.02em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  pill: "999px"
spacing:
  gap-1: "4px"
  gap-2: "8px"
  gap-3: "12px"
  gap-4: "16px"
  gap-5: "24px"
  gap-6: "32px"
  gap-8: "48px"
  pad-card: "20px"
components:
  button-primary:
    backgroundColor: "{colors.brown}"
    textColor: "{colors.cream}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.brown-2}"
    textColor: "{colors.cream}"
  button-accent:
    backgroundColor: "{colors.ember}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-accent-hover:
    backgroundColor: "{colors.ember-deep}"
    textColor: "#FFFFFF"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brown}"
    rounded: "{rounded.sm}"
    padding: "8px 8px"
  input:
    backgroundColor: "{colors.cream-soft}"
    textColor: "{colors.brown}"
    rounded: "{rounded.sm}"
    padding: "9px 12px"
  card:
    backgroundColor: "{colors.cream-soft}"
    rounded: "{rounded.md}"
    padding: "20px"
  pill-status:
    backgroundColor: "transparent"
    textColor: "{colors.brown}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
---

# Design System: Crumb

## 1. Overview

**Creative North Star: "The Paper Trail."**

Crumb is a warm-paper workspace for closing feedback loops, and its whole identity comes from a single metaphor made literal: feedback is a crumb, and the work is following the trail from *heard* to *the customer heard back*. The surface is cream paper with a faint vignette and printed-fiber grain; the ink is a toasted brown; and a single ember orange is the trail itself — used only on the active path. Nothing here is cold, glassy, or chrome-heavy. It reads like a well-set field notebook that happens to be a fast B2B tool.

The system is **dense where the work needs it and calm everywhere else.** Inbox rows, status tables, and threads pack information at a 13px body size with hairline dividers; headers, empty states, and brand moments breathe. Personality arrives in microdoses — the trail-of-dots mark, the animated crumb loader, a wink of copy — and then gets out of the way so triage can happen. Familiarity is a feature: standard top-bar + side-nav, command palette, predictable form controls. The tool disappears into the task.

It explicitly rejects the generic-SaaS default (cold blue/gray, gradient hero-metric cards, identical icon-card grids), enterprise heaviness (Jira/Salesforce chrome and joyless density), trendy "AI tool" dark mode (neon, glass, purple gradients), and anything childish (emoji-soup, bubbly toy shapes). Warmth is carried by palette, paper texture, and type — never by gimmick.

**Key Characteristics:**
- Cream paper surface with a locked vignette + fiber texture; flat by default.
- Toasted-brown ink, ember as the one accent — the trail, used sparingly.
- Hairline borders (brown at 10–15% opacity) carry nearly all the structure.
- Soft, not pillowy radii (4–10px); two warm-tinted shadows reserved for floating layers only.
- General Sans for display/headings, Inter for all working text, JetBrains Mono for code and tabular hints.
- The loop made visible: the **TrailDots** progress mark is the signature component.

## 2. Colors

A deliberately two-tone palette — cream and toasted brown — with ember as the single trail color and a small, warm semantic set for status. Everything tilts warm; nothing is allowed to go cold.

### Primary
- **Ember** (`#E27D3A`): The trail. The one true accent. Reserved for the active path — primary/positive actions, the current selection, in-progress status, focus rings, the brand mark and loaders. Its scarcity is the point.
- **Ember Soft** (`#FCE9D6`): Tinted wash behind a selected nav item, selected list row, and the focus-ring glow. The quiet half of the accent.
- **Ember Deep** (`#B45F23`): The accessible ember — used for ember-on-cream *text* (links, "create" affordances, footer links) where the bright ember would be too light, and for the accent button's hover.

### Secondary
- **Toasted Brown** (`#4A2E1F`): Primary ink. All headings and body text, the ink button fill, and — via opacity steps — every border and muted tone in the app. This is the workhorse color.
- **Brown 2** (`#6A4528`): Slightly lifted brown for secondary text (nav items, amber-status text) and the ink button's hover.
- **Brown opacities** (`rgba(74,46,31,·)` at .06/.10/.15/.30/.50/.65): the structural backbone — `.10` and `.15` are the hairline borders, `.06` is the hover wash, `.65` is muted body text. The palette stays two-tone because the "grays" are just transparent brown.

### Tertiary (status semantics)
- **Green** (`#6B8E5A`) / **Green Soft** (`#E8EFE0`): Shipped. The loop closed well.
- **Amber** (`#D4A24C`) / **Amber Soft** (`#F8EFD5`): Set aside / deferred.
- **Rust** (`#B3573A`) / **Rust Soft** (`#F3DBCE`): Won't ship. Also the parent of all error states.
- **Rust Deep** (`#8A3A3A`): Inline error text and the danger button — error derives from rust so the palette never reaches for a cold, generic red.

### Neutral
- **Cream** (`#FBF7F0`): The body and top-bar background — the paper itself.
- **Cream Soft** (`#FDFAF4`): The slightly brighter surface for cards, inputs, popovers, the ⌘K palette — what sits *on* the paper.
- **Cream 2** (`#F4EEE2`): The recessed tone — avatars, skeleton base, deeper layering.
- **Oat Deep** (`#1A1815`): Near-black brown, used only for the inverted code block and the mobile scrim.
- **Warm Gray** (`#8A8278`): The single true gray — tertiary text and placeholders only, never load-bearing.

### Named Rules
**The One-Trail Rule.** Ember is the trail, not a theme color. It marks the active path and nothing else — primary action, current selection, in-progress, focus. Keep it under ~10% of any screen; if two embers compete, one is decoration and must go.

**The Two-Tone Rule.** The palette is cream + toasted brown. "Grays" are transparent brown, not neutral grays. Status colors (green/amber/rust) are warm and muted. Errors derive from rust, never a stock red. Never introduce a cold blue, a true gray, or a second saturated hue.

## 3. Typography

**Display Font:** General Sans (with GT Walsheim / Söhne / system-ui fallbacks) — loaded from Fontshare.
**Body Font:** Inter (with system-ui fallback).
**Label / Mono Font:** JetBrains Mono (with ui-monospace fallback).

**Character:** General Sans is a friendly geometric-humanist sans that gives headings, the wordmark, and big KPI numbers a confident, slightly editorial set without going corporate. Inter does all the working text — dense, legible, neutral on purpose. The two are paired on a role axis (display vs. text), never mixed within the same line. Mono appears only for code, keyboard hints, and where digits should align.

### Hierarchy
- **Display** (General Sans 600, 40px / `--fs-4xl`, line-height 1.08, -0.015em): Page H1 (`PageHead`) and large KPI numbers. The biggest voice on any screen — fixed, not fluid; drops to 28px under 640px.
- **Headline** (General Sans 600, 24–30px / `--fs-2xl`–`3xl`, line-height ~1.2): Secondary page and section headings.
- **Title** (General Sans 600, 16px / `--fs-lg`, line-height 1.3, -0.01em): Sub-section titles and design-system tile titles.
- **Body** (Inter 400, 13px / `--fs-body`, line-height 1.5): The default. All working copy, list rows, form values. Prose ledes cap at ~64ch; dense tables may run wider.
- **Overline / Card title** (General Sans 600, 12px / `--fs-sm`, uppercase, +0.10em): Card headers — small, tracked, set in the display face for a quiet editorial stamp.
- **Label** (Inter 500, 10px / `--fs-2xs`, uppercase, +0.14em): Eyebrows, field labels, nav section headers, KPI captions, breadcrumbs. The most-used "small" treatment in the app.

### Named Rules
**The Display-For-Moments Rule.** General Sans is for headings, the wordmark, and numbers that deserve weight. Inter carries every label, input, table cell, and paragraph of working text. A display font inside a data row or a control label is always wrong.

**The Brown-Ink Rule.** Body text is full `--text` (toasted brown) at ≥4.5:1. Muted brown (`--mute`) is for secondary/supporting copy; warm-gray (`--mute-2`) is for placeholders and tertiary hints only. Never demote load-bearing body copy to a muted tone for "elegance."

## 4. Elevation

Crumb is **flat on paper.** Depth is built three ways, in order of preference: hairline borders (brown at 10–15%), tonal layering (cream → cream-soft → cream-2), and — only for things that genuinely float above the page — a soft warm-tinted shadow. The whole app sits on a fixed paper texture: a radial vignette (`::before`) and two layers of fine repeating-linear-gradient "fibers" (`::after`), both in low-opacity brown, locked behind the content and below the nav. That grain is the elevation baseline; surfaces lift off it, they don't cast drama onto it.

### Shadow Vocabulary
- **Near** (`box-shadow: 0 1px 0 rgba(74,46,31,0.04)`): A 1px warm seam — barely-there separation for sticky/resting edges.
- **Soft** (`box-shadow: 0 2px 8px -3px rgba(74,46,31,0.08), 0 1px 2px rgba(74,46,31,0.04)`): The only "real" shadow. Used exclusively on floating layers — dropdown menus, the avatar/notification popovers, the ⌘K command palette, the @-mention menu, mention/dialog surfaces.

### Named Rules
**The Flat-On-Paper Rule.** Surfaces are flat at rest; structure comes from hairlines and tonal steps. A shadow is permitted only when an element leaves the page plane (a menu, popover, or modal over a scrim). Cards, rows, inputs, and pills never carry a shadow.

## 5. Components

Lead with the feel, then the spec. Every interactive component carries default / hover / focus states; the accent and warmth show up in states, not at rest.

### Buttons
- **Shape:** Soft 4px corners (`--r-sm`); compact by default (8px 14px), with `.sm` (5px 10px) and `.lg` (11px 20px) sizes and a 30px square `.icon-only`.
- **Outline (default `.btn`):** Transparent fill, 1px brown border, brown text; on hover it *inverts* to brown fill + cream text. The everyday button.
- **Primary (`.btn.primary`):** Toasted-brown ink fill, cream text; hover lifts to brown-2.
- **Accent (`.btn.accent`):** Ember fill, white text; hover deepens to ember-deep. Reserved for the single primary/forward action — submit, send, the loop-closing move.
- **Ghost (`.btn.ghost`):** No border, muted text, hover wash (`--hover`) — for low-emphasis and icon actions.
- **Danger (`.btn.danger`):** Rust-deep fill, cream text — destructive only.

### Pills & Badges
- **Style:** Transparent by default. Tone is carried by a 6px `dot`, the border color, and the text color — *the fill never fights the paper texture.* Variants: `ink` (solid brown — the one filled pill), `accent`, `green`, `amber`, `rust`, `ghost`, `muted`. Fully rounded (999px), 11px text.
- **Status Pill:** Combines a `status-dot` with a label across eight states — Open, In review, Planned, In progress, Shipped, Won't ship, Set aside, Duplicate — colored by the status family (ember for planned/progress, green for shipped, rust for declined, amber for deferred, ghost for triage).
- **Type Chip:** Ghost pill + 11px icon for Bug / Idea / Question.

### Cards / Containers
- **Corner Style:** 6px (`--r-md`).
- **Background:** Cream-soft on the cream body — one tonal step of lift, no shadow.
- **Border:** A single hairline (`1px solid var(--hair)`); `--border-strong` (15%) where a touch more definition is needed.
- **Structure:** `card-head` (14px/20px padding, hairline base, uppercase 12px title) → `card-body` / `card-pad` (20px) → optional `card-foot`.
- **The lazy-card warning:** cards are used as containers, not as a grid reflex. Lists, tables, and KPI rows are bare on the page far more often than they're boxed.

### Inputs / Fields
- **Style:** Cream-soft fill, hairline border, 4px corners, 9px/12px padding, 13px Inter.
- **Focus:** Border shifts to ember and a 3px ember-soft glow appears (`box-shadow: 0 0 0 3px var(--accent-soft)`) — the same focus signature on inputs, dropdown triggers, and the switch.
- **Field:** Stacked `field-label` (uppercase 10px) + control + optional `field-help`. Errors derive from rust (`--err-text` / `--err-bg` / `--err-border`).
- **Controls share the focus vocabulary:** the `switch` (30×16 pill, ember when on), the `seg` segmented control (ink-filled selected tab), and the searchable `Dropdown` (cream-soft trigger, soft-shadow menu, ember tick on the selected option).

### Navigation
- **Top bar:** 52px sticky, cream, hairline base. Wordmark in General Sans 600 + the trail-of-dots `BrandMark`, an italic workspace name, inline tabs, a ⌘K trigger, notification bell, and avatar menu. Selected tab gets an ember-soft wash.
- **Side nav:** 232px. Uppercase 10px section labels; nav items at 14px. The **active item** is marked by a 3px ember vertical bar to its left and a fully-lit ember icon — the only place the rail color appears.
- **Mobile (≤767px):** tabs collapse into a hamburger-triggered off-canvas sheet (280px) over a brown scrim.

### Signature: The Trail (loop made visible)
- **TrailDots:** Four dots along an item's trail — *heard → answered → decided → closed* — derived from the item's status and whether a vendor replied. Lit stages are filled ember circles that grow stage by stage; unlit stages are hairline rings. The `aria-label` reads the lit stages and whether the loop is **open** or **closed**. This is the product's thesis rendered as a 36×10 SVG.
- **BrandMark:** Five ember dots of increasing size and opacity tracing a curve — a crumb trail. Reused at favicon size and in the widget launcher.
- **Trail Loader:** Four pulsing ember dots (staggered 0.15s) — the brand's loading state, echoing the mark.
- **Skeletons:** A warm shimmer (`crumb-shimmer`, cream-2 → cream-soft → cream-2) for tile-level loading — never a centered spinner. Both the loader and shimmer fully stop under `prefers-reduced-motion`.

## 6. Do's and Don'ts

### Do:
- **Do** keep ember as the trail: primary action, current selection, in-progress, and focus only — under ~10% of any screen (The One-Trail Rule).
- **Do** build structure from hairline borders (brown 10–15%) and tonal steps (cream → cream-soft → cream-2) before reaching for anything heavier.
- **Do** keep surfaces flat on the paper; use the `soft` shadow only on things that float (menus, popovers, ⌘K, modals) — The Flat-On-Paper Rule.
- **Do** keep status pills transparent and tone them with dot + border + text, so the fill never fights the paper texture.
- **Do** set body in full toasted-brown at ≥4.5:1; reserve muted brown and warm-gray for secondary and placeholder text.
- **Do** pair status color with a label and give the trail an `aria-label` — color is never the only signal.
- **Do** give every animation a `prefers-reduced-motion` fallback (the shimmer and trail already degrade to static).

### Don't:
- **Don't** ship the generic-SaaS look: cold blue/gray neutrals, gradient hero-metric cards, or identical icon + heading + text card grids.
- **Don't** drift toward enterprise heaviness — Jira/Salesforce chrome, joyless density, a toolbar for every action.
- **Don't** go dark, glassy, or neon. No "AI tool" dark mode, no glassmorphism, no purple gradients — it breaks the paper material.
- **Don't** get childish: no emoji-soup, no bubbly over-rounded toy shapes. Playfulness stays in microdoses (the trail motif, a line of copy).
- **Don't** introduce a cold gray, a blue, or a second saturated accent — the palette is cream + toasted brown + the one ember (The Two-Tone Rule).
- **Don't** reach for a stock red on errors; derive them from rust (`--rust-deep`) so the palette stays warm.
- **Don't** put the General Sans display face into data rows, control labels, or table cells (The Display-For-Moments Rule).
- **Don't** use a `border-left`/`border-right` color stripe on cards or rows; the active marker is a short ember bar with a tinted wash, applied deliberately on nav and selected list rows only.
