"use client";

import { useState, useTransition } from "react";
import { Btn, Ic, Pill } from "@crumb/ui";
import { revealSecret, rotateSecret } from "./actions";

export function SecretReveal({ isAdmin }: { isAdmin: boolean }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!isAdmin) {
    return (
      <div className="text-sm muted" style={{ padding: "10px 0" }}>
        Only workspace admins can view or rotate the signing secret.
      </div>
    );
  }

  const onReveal = () => {
    setError(null);
    startTransition(async () => {
      const r = await revealSecret();
      if (r.ok) setSecret(r.secret);
      else setError(r.error);
    });
  };

  const onRotate = () => {
    setError(null);
    startTransition(async () => {
      const r = await rotateSecret();
      if (r.ok) { setSecret(r.secret); setConfirming(false); }
      else setError(r.error);
    });
  };

  const onCopy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); } catch { /* noop */ }
  };

  if (!secret) {
    return (
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Btn sm onClick={onReveal} disabled={pending}>
          {pending ? "Loading…" : "Reveal signing secret"}
        </Btn>
        <span className="text-xs muted">You'll only show this to your own server, never the browser.</span>
        {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      </div>
    );
  }

  return (
    <div className="col gap-2" style={{ alignItems: "stretch" }}>
      <div className="row gap-2 center" style={{
        border: "var(--border)",
        borderRadius: "var(--r-sm)",
        padding: "8px 10px",
        background: "var(--bone-2)",
      }}>
        <span className="mono text-xs" style={{ flex: 1, wordBreak: "break-all", lineHeight: 1.5 }}>{secret}</span>
        <Btn sm variant="ghost" icon={<Ic.copy style={{ width: 11, height: 11 }} />} onClick={onCopy}>Copy</Btn>
      </div>
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <span className="text-xs muted">Store this as <span className="mono">CRUMB_SIGNING_SECRET</span> on your server.</span>
        <div style={{ flex: 1 }} />
        {confirming ? (
          <>
            <span className="text-xs" style={{ color: "var(--err-text)" }}>This invalidates any tokens already signed. Sure?</span>
            <Btn sm onClick={() => setConfirming(false)} disabled={pending}>Cancel</Btn>
            <Btn sm variant="primary" onClick={onRotate} disabled={pending}>{pending ? "Rotating…" : "Rotate now"}</Btn>
          </>
        ) : (
          <Btn sm variant="ghost" onClick={() => setConfirming(true)}>Rotate…</Btn>
        )}
      </div>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}
