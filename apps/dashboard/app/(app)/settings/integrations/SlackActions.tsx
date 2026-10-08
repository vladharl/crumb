"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { errorMessage } from "@/lib/action-error";
import { startSlackInstall, disconnectSlack } from "./actions";
import { isRedirectError, connectErrorMessage } from "./connect-shared";

export function ConnectSlackButton({ disabled }: { disabled?: boolean }) {
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
            // Success path redirects to Slack (NEXT_REDIRECT, re-thrown below);
            // a returned result means a gating failure we can explain.
            const r = await startSlackInstall();
            if (r) setError(connectErrorMessage(r.error));
          } catch (e) {
            if (isRedirectError(e)) throw e;
            setError("Couldn't start the connection. Please try again.");
          }
        })}
      >
        {pending ? "Opening Slack…" : "Connect Slack"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

export function DisconnectSlackButton({ teamName }: { teamName: string | null }) {
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
            title: `Disconnect Crumb from ${teamName ?? "Slack"}?`,
            body: "Teammates' Slack alerts go back to email, and /crumb and @mentions of Crumb stop working.",
            confirmLabel: "Disconnect",
            destructive: true,
          }))) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnectSlack();
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
