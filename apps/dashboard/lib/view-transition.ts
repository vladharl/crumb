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

  const startedAt = performance.now();
  // The destination heading only appears once the route's content streams in
  // (its loading skeleton has no title). Hold the "after" snapshot until the
  // real heading — tagged with our morph name — is in the DOM, so the row title
  // morphs into the heading rather than cross-fading into a skeleton.
  const ready = () => {
    const h1 = document.querySelector<HTMLElement>(".content-head h1");
    return !!h1 && getComputedStyle(h1).viewTransitionName === TITLE_VT;
  };

  // Mark the morph as active so the per-route settle (template.tsx .route-fade)
  // stands down — the transition owns the motion for this navigation.
  document.documentElement.dataset.vtActive = "";

  const transition = (document as Document & {
    startViewTransition: (cb: () => Promise<void> | void) => { finished: Promise<void> };
  }).startViewTransition(() => {
    router.push(href);
    return new Promise<void>((resolve) => {
      const settle = () =>
        // One extra frame so the browser lays the heading out before the
        // "after" snapshot is captured.
        requestAnimationFrame(() => resolve());
      const tick = () => {
        // Resolve as soon as the destination heading is painted (the real
        // signal). In production a route's loading UI appears within a frame or
        // two, so this fires fast; the cap is only a safety so a pathologically
        // slow stream can't hold the old view on screen indefinitely.
        if (ready() || performance.now() - startedAt > 1500) settle();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

  void transition.finished.finally(() => {
    clearTags();
    delete document.documentElement.dataset.vtActive;
  });
}
