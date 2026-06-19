"use client";

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Btn, Ic } from "@crumb/ui";
import { completeTour } from "@/app/(app)/actions";

/**
 * First-sign-in getting-started walkthrough. On a user's first visit (when the
 * server says guide_completed_at is null) this auto-opens a spotlight tour that
 * dims the screen and highlights each sidebar section in turn. Mirrors the
 * provider + fixed-overlay idiom of components/confirm.tsx.
 *
 * Targeting is sidebar-only: every step points at a nav item that is always
 * mounted in AppShell (located by a data-tour="<id>" attribute), so no route
 * navigation happens mid-tour. Under 768px the sidebar is off-canvas, so we fall
 * back to a centered carousel modal instead of spotlighting a hidden element.
 */

type TourStep = {
  /** Matches the nav item's data-tour attribute (the NavLink id). */
  target: string;
  /** Icon key for the mobile carousel fallback. */
  icon: keyof typeof Ic;
  title: string;
  body: string;
};

const STEPS: TourStep[] = [
  {
    target: "inbox",
    icon: "inbox",
    title: "Every item is an open loop",
    body: "Customers drop feedback here from your widget, email, or Slack, with account and session attached. Each one is a loop that stays open until they hear back.",
  },
  {
    target: "accounts",
    icon: "building",
    title: "Weigh loops by revenue",
    body: "Everyone who's sent feedback, sorted by ARR, so you answer the loops that matter most first. The view to open before every QBR.",
  },
  {
    target: "initiatives",
    icon: "road",
    title: "Decide in the open",
    body: "Group loops into themes on a Now / Next / Later board, and mark it public so customers can watch their feedback move toward shipped.",
  },
  {
    target: "insights",
    icon: "chart",
    title: "Watch the loop shrink",
    body: "One number to beat: how long customers wait to hear back. Loop time, open loops, and the ARR sitting on an answer all live here.",
  },
  {
    target: "cmdk",
    icon: "search",
    title: "Jump anywhere",
    body: "Press ⌘K (Ctrl-K) to jump to any page or setting without leaving the keyboard.",
  },
  {
    target: "notifs",
    icon: "bell",
    title: "When the ball comes back",
    body: "Replies, new submissions, and mentions land in this bell. Each one means it's your turn again. Tune what reaches you in Settings → Notifications.",
  },
  {
    target: "settings",
    icon: "settings",
    title: "Close your first loop",
    body: "Open this menu to install the widget, connect Slack or your CRM, and invite teammates. When something ships, Crumb tells the customer. The loop closes itself. Follow the trail.",
  },
];

const MOBILE_QUERY = "(max-width: 767px)";
const CALLOUT_WIDTH = 320;

type TourCtx = { start: () => void };
const Ctx = createContext<TourCtx | null>(null);

export function useTour() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTour must be used within <TourProvider>");
  return ctx;
}

type Rect = { top: number; left: number; width: number; height: number };

export function TourProvider({ autoStart, children }: { autoStart: boolean; children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  // Auto-open only after mount so the first server/client render match (no
  // hydration mismatch — the overlay is absent on the server).
  useEffect(() => {
    if (autoStart) setActive(true);
  }, [autoStart]);

  // Track viewport so we can swap the spotlight for a carousel on small screens.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Mirror `step` into a ref so next() can read the current step without a stale
  // closure AND without calling finish() inside a setState updater (which warns
  // about updating another component mid-render).
  const stepRef = useRef(0);
  useEffect(() => { stepRef.current = step; }, [step]);

  const start = useCallback(() => {
    setStep(0);
    setActive(true);
  }, []);

  const finish = useCallback(() => {
    setActive(false);
    // Fire-and-forget: closing the UI shouldn't wait on the network. A failed
    // write just means the tour reappears next sign-in, which is acceptable.
    void completeTour().catch(() => {});
  }, []);

  const next = useCallback(() => {
    if (stepRef.current >= STEPS.length - 1) finish();
    else setStep(s => s + 1);
  }, [finish]);

  const back = useCallback(() => setStep(s => Math.max(0, s - 1)), []);

  // Keyboard navigation while the tour is open (mirrors confirm.tsx).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, next, back, finish]);

  return (
    <Ctx.Provider value={{ start }}>
      {children}
      {active && (
        isMobile
          ? <CarouselOverlay step={step} onNext={next} onBack={back} onSkip={finish} />
          : <SpotlightOverlay step={step} onNext={next} onBack={back} onSkip={finish} />
      )}
    </Ctx.Provider>
  );
}

/** Spotlight: dim everything but the targeted nav item, callout beside it. */
function SpotlightOverlay({
  step, onNext, onBack, onSkip,
}: { step: number; onNext: () => void; onBack: () => void; onSkip: () => void }) {
  const current = STEPS[step];
  const [rect, setRect] = useState<Rect | null>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  const [calloutH, setCalloutH] = useState(180);

  // Measure the target element; auto-advance if it isn't in the DOM (e.g. a
  // gated nav item), rather than rendering a hole at 0,0.
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      if (!el) { onNext(); return; }
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [current.target, onNext]);

  useLayoutEffect(() => {
    if (calloutRef.current) setCalloutH(calloutRef.current.getBoundingClientRect().height);
  }, [step, rect]);

  if (!rect) return null;

  const pad = 6;
  const hole = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };

  // Prefer the callout to the right of the item; flip below if it would overflow.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const rightX = hole.left + hole.width + 12;
  const fitsRight = rightX + CALLOUT_WIDTH <= vw - 12;
  const left = fitsRight ? rightX : Math.max(12, Math.min(hole.left, vw - CALLOUT_WIDTH - 12));
  const top = fitsRight
    ? Math.max(12, Math.min(rect.top, vh - calloutH - 12))
    : Math.min(hole.top + hole.height + 12, vh - calloutH - 12);

  return (
    <div role="dialog" aria-modal="true" aria-label="Getting started">
      {/* Transparent click-catcher under the cutout — blocks the app, no-op on click. */}
      <div style={{ position: "fixed", inset: 0, zIndex: 69 }} />
      {/* The hole: a box-shadow spread paints the scrim everywhere but here. */}
      <div
        style={{
          position: "fixed",
          top: hole.top, left: hole.left, width: hole.width, height: hole.height,
          borderRadius: "var(--r-md)",
          boxShadow: "0 0 0 9999px rgba(28, 24, 21, 0.55)",
          pointerEvents: "none",
          transition: "top 180ms ease, left 180ms ease, width 180ms ease, height 180ms ease",
          zIndex: 70,
        }}
      />
      <Callout
        ref={calloutRef}
        style={{ position: "fixed", top, left, width: CALLOUT_WIDTH, zIndex: 71 }}
        step={step}
        onNext={onNext}
        onBack={onBack}
        onSkip={onSkip}
      />
    </div>
  );
}

/** Mobile fallback: centered carousel, no DOM targeting. */
function CarouselOverlay({
  step, onNext, onBack, onSkip,
}: { step: number; onNext: () => void; onBack: () => void; onSkip: () => void }) {
  const current = STEPS[step];
  const Icon = Ic[current.icon];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Getting started"
      style={{
        position: "fixed", inset: 0, background: "rgba(28, 24, 21, 0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 60, padding: 24,
      }}
    >
      <Callout style={{ width: "min(360px, 100%)" }} step={step} onNext={onNext} onBack={onBack} onSkip={onSkip} icon={<Icon style={{ width: 22, height: 22 }} />} />
    </div>
  );
}

/** Shared callout card used by both the spotlight and the mobile carousel. */
type CalloutProps = {
  step: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  style?: CSSProperties;
  icon?: ReactNode;
};

const Callout = forwardRef<HTMLDivElement, CalloutProps>(function Callout(
  { step, onNext, onBack, onSkip, style, icon },
  ref,
) {
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        background: "var(--paper, var(--surface))",
        border: "1px solid var(--line, var(--hair))",
        borderRadius: "var(--r-md)",
        padding: 18,
        boxShadow: "var(--sh-soft)",
        ...style,
      }}
    >
      <div className="row between" style={{ alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <div className="row gap-2" style={{ alignItems: "center" }}>
          {icon}
          <h3 className="serif" style={{ margin: 0, fontSize: 16 }}>{current.title}</h3>
        </div>
        <button
          onClick={onSkip}
          className="link-back"
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: "var(--fs-xs, 12px)" }}
        >
          Skip
        </button>
      </div>
      <p className="text-sm muted" style={{ margin: "0 0 16px", lineHeight: 1.55 }}>{current.body}</p>
      <div className="row between" style={{ alignItems: "center" }}>
        <div className="row" style={{ gap: 5 }} aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                width: 6, height: 6, borderRadius: "50%",
                background: i === step ? "var(--ember)" : "var(--line, var(--hair))",
                transition: "background 150ms ease",
              }}
            />
          ))}
        </div>
        <div className="row gap-2">
          {step > 0 && <Btn sm onClick={onBack}>Back</Btn>}
          <Btn sm variant="primary" onClick={onNext}>{isLast ? "Done" : "Next"}</Btn>
        </div>
      </div>
    </div>
  );
});

/**
 * Sidebar entry that relaunches the walkthrough. Styled like the adjacent
 * "Sign out →" link. Must render inside <TourProvider>.
 */
export function TourLauncher() {
  const { start } = useTour();
  return (
    <button
      onClick={start}
      className="link-back"
      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
    >
      Getting started →
    </button>
  );
}
