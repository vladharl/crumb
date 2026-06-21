"use client";

import { useState, useTransition } from "react";
import { Btn, Field, Ic } from "@crumb/ui";
import { startSignup } from "./actions";
import { TurnstileWidget } from "./TurnstileWidget";

export function SignupForm({ turnstileSiteKey }: { turnstileSiteKey?: string | null }) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  if (sent) {
    return (
      <div className="text-sm" style={{
        background: "var(--bone-2)",
        border: "var(--border)",
        borderRadius: "var(--r-sm)",
        padding: "12px 14px",
        lineHeight: 1.55,
      }}>
        <strong style={{ fontWeight: 600 }}>Check your email.</strong> We sent a confirmation
        link to <span className="mono">{adminEmail}</span>. Click it to finish creating your
        workspace and sign in — the link expires in 30 minutes.
      </div>
    );
  }

  return (
    <form
      className="col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const form = new FormData(e.currentTarget);
        startTransition(async () => {
          const res = await startSignup(form);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          setSent(true);
        });
      }}
    >
      <Field label="Workspace name" help="Shown to your customers and on outbound emails.">
        <input
          name="workspaceName"
          required
          autoFocus
          className="input"
          placeholder="Acme Inc."
          value={workspaceName}
          onChange={e => setWorkspaceName(e.target.value)}
          disabled={pending}
        />
      </Field>

      <hr className="divider" />

      <Field label="Your name">
        <input
          name="adminName"
          required
          className="input"
          placeholder="Jane Doe"
          value={adminName}
          onChange={e => setAdminName(e.target.value)}
          disabled={pending}
        />
      </Field>

      <Field label="Your work email" help="We'll send a confirmation link here. You sign in with it via magic link.">
        <input
          name="adminEmail"
          type="email"
          required
          autoComplete="email"
          className="input"
          placeholder="you@acme.com"
          value={adminEmail}
          onChange={e => setAdminEmail(e.target.value)}
          disabled={pending}
        />
      </Field>

      <TurnstileWidget siteKey={turnstileSiteKey} />

      {error && (
        <div className="text-sm" style={{
          background: "var(--err-bg)",
          border: "1px solid var(--err-border)",
          color: "var(--err-text)",
          borderRadius: "var(--r-sm)",
          padding: "10px 12px",
        }}>{error}</div>
      )}

      <Btn variant="primary" lg full icon={<Ic.send style={{ width: 12, height: 12 }} />} disabled={pending}>
        {pending ? "Sending confirmation…" : "Create workspace"}
      </Btn>
    </form>
  );
}
