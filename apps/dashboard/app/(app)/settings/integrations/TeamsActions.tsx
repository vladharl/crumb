"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { setTeamsWebhook, disconnectTeams, testTeamsWebhook } from "./actions";

function errText(e: string): string {
  switch (e) {
    case "teams_invalid_url": return "That isn't a valid https webhook URL (or the host isn't allowed).";
    case "forbidden":         return "Only workspace admins can change this.";
    case "not_connected":     return "Connect a webhook first.";
    default:                  return "Something went wrong. Try again.";
  }
}

export function ConnectTeamsForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="col gap-2">
      <input
        className="input"
        placeholder="https://…webhook.office.com/… or …logic.azure.com/…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={pending}
      />
      <div className="row gap-2 center">
        <Btn
          sm
          variant="primary"
          icon={<Ic.plug style={{ width: 12, height: 12 }} />}
          disabled={pending || !url.trim()}
          onClick={() => start(async () => {
            setError(null);
            const r = await setTeamsWebhook(url.trim());
            if (r.ok) router.refresh();
            else setError(errText(r.error));
          })}
        >
          {pending ? "Connecting…" : "Connect"}
        </Btn>
        {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      </div>
    </div>
  );
}

export function TeamsConnectedActions() {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        icon={<Ic.send style={{ width: 11, height: 11 }} />}
        disabled={pending}
        onClick={() => start(async () => {
          setError(null);
          setMsg(null);
          const r = await testTeamsWebhook();
          if (r.ok) setMsg("Sent a test card.");
          else setError(errText(r.error));
        })}
      >
        {pending ? "Sending…" : "Send test"}
      </Btn>
      <Btn
        sm
        disabled={pending}
        onClick={async () => {
          if (!(await confirm({ title: "Disconnect Teams?", body: "Notifications will stop posting to that channel.", confirmLabel: "Disconnect", destructive: true }))) return;
          start(async () => {
            const r = await disconnectTeams();
            if (r.ok) router.refresh();
            else setError(errText(r.error));
          });
        }}
      >
        Disconnect
      </Btn>
      {msg && <span className="text-xs muted">{msg}</span>}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}
