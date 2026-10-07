"use client";

import { useEffect, useState } from "react";
import { Pill } from "@crumb/ui";
import { widgetFirstPingAt } from "./actions";

// Live install check: polls (while the tab is visible) until the widget's
// first real ping is stamped, then stops.
export function WidgetStatus({ initial }: { initial: string | null }) {
  const [at, setAt] = useState(initial);

  useEffect(() => {
    if (at) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      widgetFirstPingAt().then(v => { if (v) setAt(v); }, () => { /* retry next tick */ });
    }, 5000);
    return () => clearInterval(id);
  }, [at]);

  return (
    <div role="status" className="row gap-2 center text-sm">
      {at ? (
        <Pill variant="green" dot>Widget connected</Pill>
      ) : (
        <>
          <span className="trail-loader" aria-hidden><span /><span /><span /><span /></span>
          Waiting for your widget&apos;s first ping
        </>
      )}
    </div>
  );
}
