"use client";

import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/**
 * Spread onto an element to make it inert: no focus, no clicks, hidden from
 * assistive tech. React 18 has no `inert` prop, so this sets the attribute in
 * its empty-string form (React 19 takes a boolean).
 */
export const inert = (on: boolean): object => (on ? { inert: "" } : {});

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable="true"]';

function tabStops(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0);
}

/**
 * Where Tab sends focus to stay inside: the other end when it's at an edge (or
 * on the card itself), else null and the browser's own move is fine.
 */
export function wrapTab<T>(stops: readonly T[], active: T | null, back: boolean): T | null {
  if (stops.length === 0) return null;
  const at = active === null ? -1 : stops.indexOf(active);
  if (back) return at <= 0 ? stops[stops.length - 1] : null;
  return at === -1 || at === stops.length - 1 ? stops[0] : null;
}

// Open modal cards, innermost last: only the top one answers keys that land
// outside every card.
const openCards: HTMLElement[] = [];

/**
 * What makes a dialog modal while `open`. The rest of the page goes inert
 * (live regions excepted, so toasts still speak). Focus moves into `card`
 * (to `initialFocus`, else the first control) and Tab wraps inside it.
 * Escape calls onClose, and focus goes back to whatever had it on the way in.
 * `root` is the dialog's outermost element, scrim included. Returns the
 * card's keydown handler.
 */
export function useModal(
  open: boolean,
  rootRef: RefObject<HTMLElement>,
  cardRef: RefObject<HTMLElement>,
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement>,
) {
  // The opener is read during render: an autoFocus child takes focus in the
  // commit, before any effect could look.
  const opener = useRef<Element | null>(null);
  if (!open) opener.current = null;
  else if (!opener.current && typeof document !== "undefined") opener.current = document.activeElement;
  // Where focus settled, so a StrictMode remount puts it back there.
  const landed = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!open || !root || !card) return;
    const back = opener.current;

    const quieted: HTMLElement[] = [];
    let node: HTMLElement | null = root;
    while (node && node !== document.body) {
      const up: HTMLElement | null = node.parentElement;
      for (const sib of Array.from(up?.children ?? [])) {
        if (sib !== node && sib instanceof HTMLElement && !sib.inert && !sib.hasAttribute("aria-live")) {
          sib.inert = true;
          quieted.push(sib);
        }
      }
      node = up;
    }

    if (!card.contains(document.activeElement)) {
      [initialFocus?.current, landed.current, tabStops(card)[0], card].find(el => el && card.contains(el))?.focus();
    }
    landed.current = card.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;

    // Focus can leave the card without leaving the dialog: a button that turns
    // disabled while it works drops focus to <body>, where the card's own
    // handler never hears a key. Escape still closes, and Tab goes back in.
    openCards.push(card);
    const onPageKey = (e: KeyboardEvent) => {
      if (openCards[openCards.length - 1] !== card || card.contains(document.activeElement)) return;
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const stops = tabStops(card);
        ((e.shiftKey ? stops[stops.length - 1] : stops[0]) ?? card).focus();
      }
    };
    document.addEventListener("keydown", onPageKey);

    return () => {
      document.removeEventListener("keydown", onPageKey);
      const at = openCards.lastIndexOf(card);
      if (at >= 0) openCards.splice(at, 1);
      for (const el of quieted) el.inert = false;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [open, rootRef, cardRef, initialFocus]);

  return (e: ReactKeyboardEvent) => {
    // A menu or listbox inside handled it, or an IME owns the key.
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    const card = cardRef.current;
    if (e.key !== "Tab" || !card) return;
    const stops = tabStops(card);
    const to = stops.length ? wrapTab(stops, document.activeElement as HTMLElement | null, e.shiftKey) : card;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  };
}

/**
 * The shared modal dialog: a scrim (click closes) holding a card with
 * role=dialog, rendered at the end of <body> and modal per useModal.
 * Mount it to open it; unmount it to close.
 */
export function Dialog({
  label,
  labelledBy,
  onClose,
  className,
  style,
  scrimClassName = "sheet-scrim",
  scrimStyle,
  children,
}: {
  /** The dialog's name, when no visible title carries it (else labelledBy). */
  label?: string;
  /** id of the visible title that names the dialog. */
  labelledBy?: string;
  /** Escape and the scrim call it; so should the content's own Close. */
  onClose: () => void;
  /** The card's class: "sheet" docks as a bottom sheet on phones. */
  className?: string;
  style?: CSSProperties;
  scrimClassName?: string;
  scrimStyle?: CSSProperties;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useModal(true, rootRef, cardRef, onClose);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={rootRef} className={scrimClassName} style={scrimStyle} onClick={onClose}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={className}
        style={style}
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
