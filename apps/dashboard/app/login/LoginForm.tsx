"use client";

import { useState, useTransition } from "react";
import { Btn, Field, Ic } from "@crumb/ui";
import { requestMagicLink } from "./actions";

export function LoginForm() {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sent"; email: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  if (state.kind === "sent") {
    return (
      <div className="col gap-3">
        <div className="col gap-1">
          <span className="serif text-md">Check your email.</span>
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.5 }}>
            If <span className="mono">{state.email}</span> is on a Crumb workspace, a link is on its way. Open it on the same device to sign in.
          </p>
        </div>
        <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55 }}>
          Self-host with no email provider configured yet? The magic link is printed to the dashboard's stdout — <span className="mono">docker compose logs dashboard</span>.
        </p>
        <Btn variant="ghost" sm onClick={() => setState({ kind: "idle" })} style={{ alignSelf: "flex-start", paddingLeft: 0 }}>
          ← Use a different email
        </Btn>
      </div>
    );
  }

  return (
    <form
      className="col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const email = String(form.get("email") ?? "");
        startTransition(async () => {
          const res = await requestMagicLink(form);
          if (res.ok) setState({ kind: "sent", email });
          else setState({ kind: "error", message: res.error });
        });
      }}
    >
      <Field label="Work email" htmlFor="login-email">
        <input
          id="login-email"
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          className="input"
          placeholder="you@yourcompany.com"
          disabled={pending}
        />
      </Field>

      {state.kind === "error" && (
        <div className="text-sm" style={{ color: "var(--err-text)" }}>{state.message}</div>
      )}

      <Btn variant="primary" lg full icon={<Ic.send style={{ width: 12, height: 12 }} />} disabled={pending}>
        {pending ? "Sending…" : "Email me a link"}
      </Btn>
    </form>
  );
}
