"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { errorMessage } from "@/lib/action-error";
import { startLinearInstall, disconnectLinear } from "./actions";
import { isRedirectError, connectErrorMessage } from "./connect-shared";

export function ConnectLinearButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="col gap-1">
      <Btn
        sm
        variant="primary"
        icon={<Ic.plug style={{ width: 12, height: 12 }} />}
        disabled={disabled || pending}
        onClick={() => startTransition(async () => {
          setError(null);
          try {
            const r = await startLinearInstall();
            if (r) setError(connectErrorMessage(r.error));
          } catch (e) {
            if (isRedirectError(e)) throw e;
            setError("Couldn't start the connection. Please try again.");
          }
        })}
      >
        {pending ? "Opening Linear…" : "Connect Linear"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

export function DisconnectLinearButton({ teamName }: { teamName: string | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={async () => {
          if (!(await confirm({
            title: `Disconnect Linear (${teamName ?? "team"})?`,
            body: "Existing ticket links stay on items, but status sync will stop.",
            confirmLabel: "Disconnect",
            destructive: true,
          }))) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnectLinear();
            if (r.ok) router.refresh();
            else setError(errorMessage(r.error));
          });
        }}
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}
