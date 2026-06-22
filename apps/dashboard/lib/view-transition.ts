/**
 * Same-document View Transitions for the inbox → thread navigation — "follow
 * the trail" rendered as motion. The row the user opens lifts into the thread:
 * its title morphs into the page heading, and its loop dot grows into the
 * thread's full four-stage TrailDots. The crumb becomes the trail.
 *
 * Progressive enhancement, top to bottom:
 *   • No View Transitions API (Firefox today) → plain router.push, the existing
 *     route-fade (template.tsx) covers the swap. Identical to today.
 *   • prefers-reduced-motion → no transition, no morph. Instant.
 *   • Supported → the browser captures before/after snapshots and morphs the
 *     elements that share a view-transition-name across the two states.
 *
 * Next 14's App Router navigation is async (the RSC payload streams in), so the
 * "after" snapshot can't be taken synchronously. We hold the transition open
 * until the URL commits to the destination, then give React two frames to paint
 * — capped by a timeout so a slow fetch never freezes the page on the old view.
 */

type RouterLike = { push: (href: string) => void };

const TITLE_VT = "vt-thread-title";
const TRAIL_VT = "vt-thread-trail";

// Names assigned to the source row this navigation, cleared once it's done so a
// stale name can't collide with the next transition.
let tagged: HTMLElement[] = [];

function canTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function tag(el: Element | null | undefined, name: string) {
  if (!el || !(el instanceof HTMLElement)) return;
  el.style.viewTransitionName = name;
  tagged.push(el);
}

function clearTags() {
  for (const el of tagged) el.style.viewTransitionName = "";
  tagged = [];
}

/**
 * Open `href`, morphing from a source row when the browser allows it. `source`
 * is the row element whose title (`[data-vt-title]`) and loop dot
 * (`[data-vt-trail]`) become the shared elements; both are optional.
 */
export function navigateWithTrailMorph(
  router: RouterLike,
  href: string,
  source?: HTMLElement | null,
): void {
  if (!canTransition()) {
    router.push(href);
    return;
  }

  clearTags();
  tag(source?.querySelector("[data-vt-title]"), TITLE_VT);
  tag(source?.querySelector("[data-vt-trail]"), TRAIL_VT);

  // Hold the "after" snapshot until a heading tagged with our morph name is in
  // the DOM, then morph the row title into it. The thread's loading skeleton
  // (ThreadSkeleton) carries the same morph name on its heading, so this fires
  // as soon as the skeleton paints — we do NOT wait for the real content to
  // stream. The cap below bounds the freeze if the skeleton is slow.
  const ready = () => {
    const h1 = document.querySelector<HTMLElement>(".content-head h1");
    // Wait for the REAL heading — the title text, not the skeleton placeholder.
    // If we settled on the skeleton, the browser would snapshot it, morph to it,
    // and then the live content swaps in underneath during the animation; when
    // the transition ends and reveals that content, it flashes. The thread
    // renders in tens of ms, so the real title lands well inside the cap below;
    // only a genuinely slow load falls through to the skeleton.
    return (
      !!h1 &&
      getComputedStyle(h1).viewTransitionName === TITLE_VT &&
      (h1.textContent ?? "").trim().length > 0
    );
  };

  // Worst-case freeze, enforced by a real timer below. Normal opens settle the
  // instant the real heading lands (tens to low-hundreds of ms), so this only
  // bounds a genuinely slow load — high enough that content usually wins the
  // race (clean morph), low enough to never feel stuck.
  const MAX_HOLD_MS = 400;

  // Mark the morph as active so the per-route settle (template.tsx .route-fade)
  // stands down — the transition owns the motion for this navigation.
  document.documentElement.dataset.vtActive = "";

  const transition = (document as Document & {
    startViewTransition: (cb: () => Promise<void> | void) => { finished: Promise<void> };
  }).startViewTransition(() => {
    router.push(href);
    // Settle on a TIMER, never requestAnimationFrame. While a view transition
    // holds the old snapshot the browser pauses rendering, so rAF callbacks do
    // not fire — an rAF-driven cap would never run, and the browser would only
    // release the frozen frame at its built-in ~4s transition timeout (the
    // multi-second "frozen inbox"). setTimeout/setInterval keep firing during
    // the hold, so we settle promptly: as soon as the destination heading is in
    // the DOM (morph lands), else at the hard cap (quick cross-fade).
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(cap);
        resolve();
      };
      const poll = setInterval(() => { if (ready()) finish(); }, 24);
      const cap = setTimeout(finish, MAX_HOLD_MS);
    });
  });

  void transition.finished.finally(() => {
    clearTags();
    // The destination's `.route-fade` sat at `animation: none` while the morph
    // owned the navigation (the `[data-vt-active]` rule). Pin that to the live
    // element BEFORE clearing the flag — otherwise the rule stops matching, the
    // `route-in` keyframes (opacity 0 → 1) restart on already-visible content,
    // and the page flickers a fade-from-zero the moment the item finishes
    // loading. The next navigation mounts a fresh `.route-fade`, so this only
    // neutralizes the one the morph already covered.
    document.querySelectorAll<HTMLElement>(".route-fade").forEach((el) => {
      el.style.animation = "none";
    });
    delete document.documentElement.dataset.vtActive;
  });
}
