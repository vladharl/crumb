# Crumb demos

A small, reproducible pipeline that turns the **seeded** Crumb dashboard into
marketing assets, framed as the product's three-act story:

1. **Act 1 — your customer** drops feedback in the embedded widget and watches the public roadmap.
2. **Act 2 — you close the loop**: reply in the inbox, then make the initiative public on the roadmap.
3. **Act 3 — prioritize & ship**: weigh by ARR, and the feedback becomes a linked Linear ticket.

It produces:

- **PNG screenshots** → `../docs/assets/screenshots/` (committed)
- **Looping README GIFs** → `../docs/assets/gifs/` — one per act (committed)
- **A polished ~90s landing video** → `out/landing.mp4` + `out/landing.webm`

**Playwright** drives the real app through scripted flows (so the assets stay in
sync as the UI changes); **Remotion** composes the captured clips into a branded
reel. Raw clips and the rendered video are gitignored — only the final
`docs/assets/*` deliverables are tracked.

This package is intentionally **not** a pnpm workspace member (the workspace
globs are `apps/*` + `packages/*`), so its deps stay out of the app build and CI.

## Prerequisites

- Postgres up + seeded from the repo root: `pnpm db:up && pnpm db:push && pnpm db:seed`
- The dashboard served as a **production cloud build** — dev-mode compilation
  shows up as flicker in the video, and Act 3's AI/integration UI needs the cloud
  edition compiled in:
  ```bash
  pnpm widget:build                                   # /widget.js for Act 1
  DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb \
    pnpm --filter dashboard build:cloud
  cd apps/dashboard && \
    DATABASE_URL=postgres://crumb:crumb@localhost:5432/crumb \
    npx next start -p 3100                             # serve on :3100
  ```
  Serve on a port the widget demo can share as a single origin (the widget reads
  its API base from its own script URL). Point capture at it with
  `CRUMB_DEMO_BASE_URL=http://localhost:3100`. Leave `CRUMB_TIER` **unset**
  (entitlements default on for the self tier) and `CRUMB_ENCRYPTION_KEY` **unset**
  (so the staged `demo-*` tokens pass through unchanged).
- `ffmpeg` for GIFs + duration measurement (`brew install ffmpeg`); optional
  `gifski` for max-quality GIFs.

## One-time setup

```bash
cd demos
pnpm install --ignore-workspace   # demos/ is a standalone package, not a workspace member
pnpm approve-builds               # allow esbuild's postinstall (Remotion's bundler needs it)
pnpm run browser                  # playwright install chromium
```

## Generate everything

```bash
CRUMB_DEMO_BASE_URL=http://localhost:3100 pnpm --filter @crumb/demos all
# = seed → stage → capture → measure → gif → video
```

Or step by step:

| Command | Output |
| --- | --- |
| `pnpm --filter @crumb/demos seed` | canonical fixture (`packages/db/src/seed.ts`) |
| `pnpm --filter @crumb/demos stage` | demo-only DB staging (see below) |
| `pnpm --filter @crumb/demos capture` | `public/clips/*.webm` + `../docs/assets/screenshots/*.png` |
| `pnpm --filter @crumb/demos measure` | `remotion/clips.json` (real clip durations) |
| `pnpm --filter @crumb/demos gif` | `../docs/assets/gifs/*.gif` |
| `pnpm --filter @crumb/demos video` | `out/landing.mp4`, `out/landing.webm` |

Capture a single act: `pnpm --filter @crumb/demos capture act2-vendor-loop`.
Preview the video interactively: `npx remotion studio remotion/index.ts`.

## How it works

- **Auth** — `capture/auth.ts` mints a 24h session for the seeded admin
  (`lina@southbeam.io`) directly in Postgres and returns it as a Playwright
  storageState, exactly like `apps/dashboard/tests/e2e/setup.ts`. No magic-link
  round-trip; no `pg` dependency (uses `docker exec … psql`).
- **Staging** — `capture/stage.ts` runs *after* `db:seed` and is **never run by
  the e2e suite**, so the canonical seed stays test-safe. It writes demo-only DB
  state that the UI renders verbatim (no live third-party calls):
  - Linear + GitHub + Slack marked connected on the workspace (fake `demo-*`
    tokens — connection checks are truthy-only; tokens are never decrypted/sent).
  - Hero **FB-247** linked to Linear ticket **ENG-482 · In Progress**.
  - A pending **initiative suggestion** on FB-240 → the "AI suggests" card +
    inbox ✨ chip (pure DB read, no tier gate).
  - The hero initiative ("CSV & funnel exports") set **Private** so Act 2's
    climactic action is flipping it Public.
- **Cursor / motion** — `capture/cursor.ts` injects a soft ember cursor that
  follows eased `mouse.move` steps, plus `smoothScrollTo` / `readingScroll`
  helpers that use native smooth scrolling — no abrupt jumps. Every typing/reply
  action waits for its resulting DOM (the sent bubble / confirmation) before the
  clip moves on, so nothing is cut off mid-keystroke.
- **Flows** — `capture/flows/act{1,2,3}-*.ts`, the three acts above, all centered
  on the hero **FB-247** ("Bulk export from cohort view as CSV") so one piece of
  feedback is tracked end-to-end.
- **Compose** — `remotion/LandingHero.tsx` frames each clip in a browser window
  on Crumb's cream/ember palette (mirrors `globals.css`) with a per-act caption
  band. Each scene is sized from `remotion/clips.json` (written by
  `scripts/measure.mjs` via `ffprobe`) so it matches its clip exactly — no freeze
  on the last frame, no cut-off.

## Tuning

| Env | Default | Effect |
| --- | --- | --- |
| `CRUMB_DEMO_BASE_URL` | `http://localhost:3000` | Target app origin (use `:3100` per above) |
| `CRUMB_DEMO_SLOWMO` | `110` | ms between Playwright actions (pacing) |
| `CRUMB_DEMO_HEADED` | _(unset)_ | `1` to watch the browser drive itself |
| `GIF_WIDTH` / `GIF_FPS` | `820` / `13` | GIF size/smoothness |
| `GIF_SPEED` | `1.15` | playback speed-up (tightens dead time without dropping frames) |
| `GIFSKI` | _(unset)_ | `1` to use gifski instead of ffmpeg palette |

The committed GIFs were generated with `GIF_WIDTH=720 GIF_FPS=12 GIF_SPEED=1.7`
to keep each act under ~5 MB for GitHub.

## Notes

- **Act 3 is staged, not live.** We never click "Suggest with AI" or "Create
  ticket" against the fake Linear token during capture (that would 401) — the
  seeded end-state is what's filmed. To film a *live* AI draft instead, serve
  with `CRUMB_TIER=cloud` + a real `ANTHROPIC_API_KEY` + a real Linear/GitHub
  connection, and drive the modal in `act3`.
- **Remotion licensing** — free for individuals and companies up to **3 people**
  ([license](https://www.remotion.dev/docs/license)). Past that, a company
  license is required. Re-check before relying on it at a larger team size.
