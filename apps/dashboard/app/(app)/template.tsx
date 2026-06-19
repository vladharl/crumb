import type { ReactNode } from "react";

/**
 * A template re-renders on every navigation (unlike layout), so wrapping the
 * page in `.route-fade` gives each route a quiet content settle as it mounts —
 * a transition between views, not page-load choreography. The wrapper mirrors
 * `.content`'s flex column + gap (see globals.css) so it doesn't collapse the
 * page's section rhythm, and the animation is disabled under reduced motion.
 */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="route-fade">{children}</div>;
}
