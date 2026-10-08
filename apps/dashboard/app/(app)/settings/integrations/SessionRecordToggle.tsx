"use client";

import { useTransition } from "react";
import { Switch } from "@crumb/ui";
import { setSessionRecordEnabled } from "./actions";

export function SessionRecordToggle({ enabled, disabled }: { enabled: boolean; disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <span style={{ opacity: disabled || pending ? 0.55 : 1 }}>
      <Switch
        on={enabled}
        label="Session recording"
        onClick={() => {
          if (disabled || pending) return;
          startTransition(async () => {
            await setSessionRecordEnabled(!enabled);
          });
        }}
      />
    </span>
  );
}
