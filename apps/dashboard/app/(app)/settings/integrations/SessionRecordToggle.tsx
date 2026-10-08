"use client";

import { useTransition } from "react";
import { Switch } from "@crumb/ui";
import { setSessionRecordEnabled } from "./actions";

// Non-admins (disabled) get a real disabled switch: dimmed, and announced as
// one they can't change. While a save is in flight it only dims and ignores
// clicks, so keyboard focus stays on it.
export function SessionRecordToggle({ enabled, disabled }: { enabled: boolean; disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      on={enabled}
      label="Session recording"
      disabled={disabled}
      style={pending ? { opacity: 0.55 } : undefined}
      onClick={() => {
        if (pending) return;
        startTransition(async () => { await setSessionRecordEnabled(!enabled); });
      }}
    />
  );
}
