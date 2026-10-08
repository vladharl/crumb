"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { Btn, Field, Ic } from "@crumb/ui";
import { resendSignup, startSignup } from "./actions";
import { TurnstileWidget } from "./TurnstileWidget";

const ERROR_BOX = {
  background: "var(--err-bg)",
  border: "1px solid var(--err-border)",
  color: "var(--err-text)",
  borderRadius: "var(--r-sm)",
  padding: "10px 12px",
};

type Details = { workspaceName: string; adminName: string; adminEmail: string };

export function SignupForm({ turnstileSiteKey, billing, expired }: {
  turnstileSiteKey?: string | null;
  // A pricing CTA's ?plan=&interval= (vetted by the page), carried into the emailed link.
  billing: Record<string, string>;
  // A signup whose link expired: it prefills the form, and one click sends a fresh link.
  expired?: Details;
}) {
  const [workspaceName, setWorkspaceName] = useState(expired?.workspaceName ?? "");
  const [adminName, setAdminName] = useState(expired?.adminName ?? "");
  const [adminEmail, setAdminEmail] = useState(expired?.adminEmail ?? "");
  const [agreed, setAgreed] = useState(false);
  const [view, setView] = useState<"form" | "sent" | "expired">(expired ? "expired" : "form");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped after each submit. Turnstile tokens are single-use, so a retry or a
  // second address needs a fresh one.
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const emailInput = useRef<HTMLInputElement>(null);

  const resend = () => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await resendSignup({ workspaceName, adminEmail, ...billing });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setView("sent");
      setNotice("Sent it again. It can take a minute to show up.");
    });
  };

  const editEmail = () => {
    setError(null);
    setNotice(null);
    setView("form");
    // The form was only hidden, so the field is there to focus once it shows.
    requestAnimationFrame(() => {
      emailInput.current?.focus();
      emailInput.current?.select();
    });
  };

  return (
    <>
      {view !== "form" && (
        <div className="col gap-3">
          <div className="col gap-1">
            <span className="serif text-md">{view === "expired" ? "That link expired." : "Check your email."}</span>
            <p className="text-sm note">
              {view === "expired" ? (
                <>
                  No need to start over. We kept your details for{" "}
                  <strong style={{ fontWeight: 600 }}>{workspaceName}</strong>, so one click sends a fresh link
                  to <span className="mono">{adminEmail}</span>.
                </>
              ) : (
                <>
                  We sent a link to <span className="mono">{adminEmail.trim()}</span>. Open it to finish
                  creating your workspace and sign in.
                </>
              )}
            </p>
          </div>

          {notice && <p className="text-sm muted note" role="status">{notice}</p>}
          {error && <div className="text-sm" role="alert" style={ERROR_BOX}>{error}</div>}

          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            <Btn type="button" variant={view === "expired" ? "primary" : undefined} onClick={resend} disabled={pending}>
              {pending ? "Sending…" : view === "expired" ? "Send a new link" : "Resend the link"}
            </Btn>
            <Btn type="button" variant="ghost" onClick={editEmail} disabled={pending}>
              Use a different email
            </Btn>
          </div>
        </div>
      )}

      {/* Hidden rather than unmounted while the panel shows: Turnstile renders
          its widget once per page load, and "Use a different email" needs it. */}
      <div hidden={view !== "form"}>
        <form
          className="col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            const form = new FormData(e.currentTarget);
            startTransition(async () => {
              const res = await startSignup(form);
              setAttempt((n) => n + 1);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              setView("sent");
            });
          }}
        >
          <Field label="Workspace name" htmlFor="signup-workspace" help="Shown to your customers and on outbound emails.">
            <input
              id="signup-workspace"
              name="workspaceName"
              required
              autoFocus={!expired}
              className="input"
              placeholder="Acme Inc."
              value={workspaceName}
              onChange={e => setWorkspaceName(e.target.value)}
              disabled={pending}
            />
          </Field>

          <hr className="divider" />

          <Field label="Your name" htmlFor="signup-name">
            <input
              id="signup-name"
              name="adminName"
              required
              className="input"
              placeholder="Jane Doe"
              value={adminName}
              onChange={e => setAdminName(e.target.value)}
              disabled={pending}
            />
          </Field>

          <Field label="Your work email" htmlFor="signup-email" help="We'll send a confirmation link here. You sign in with it via magic link.">
            <input
              ref={emailInput}
              id="signup-email"
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

          {Object.entries(billing).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          <TurnstileWidget siteKey={turnstileSiteKey} resetKey={attempt} />

          <label className="text-sm muted" style={{ display: "flex", alignItems: "flex-start", gap: 8, lineHeight: 1.5, cursor: "pointer" }}>
            <input
              type="checkbox"
              name="acceptedTerms"
              checked={agreed}
              onChange={e => setAgreed(e.target.checked)}
              disabled={pending}
              style={{ marginTop: 3, flex: "0 0 auto" }}
            />
            <span>
              I agree to the{" "}
              <a href="https://crumb.localhostlabs.net/terms" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-deep)", textDecoration: "underline" }}>Terms of Service</a>
              {" "}and{" "}
              <a href="https://crumb.localhostlabs.net/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-deep)", textDecoration: "underline" }}>Privacy Policy</a>.
            </span>
          </label>

          {error && view === "form" && <div className="text-sm" role="alert" style={ERROR_BOX}>{error}</div>}

          <Btn variant="primary" lg full icon={<Ic.send style={{ width: 12, height: 12 }} />} disabled={pending || !agreed}>
            {pending ? "Sending confirmation…" : "Create workspace"}
          </Btn>
        </form>
      </div>
    </>
  );
}

// The confirm step on /signup?token=…. A plain POST form, so it works before
// hydration too; once hydrated, the button locks after the first press so a
// double click doesn't land on "already used".
export function ConfirmSignup({ token, billing, children }: {
  token: string;
  billing: Record<string, string>;
  children: ReactNode;
}) {
  const [sending, setSending] = useState(false);
  return (
    <form method="post" action="/signup/verify" className="col gap-3" onSubmit={() => setSending(true)}>
      {children}
      <input type="hidden" name="token" value={token} />
      {Object.entries(billing).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Btn type="submit" variant="primary" lg full disabled={sending}>
        {sending ? "Creating your workspace…" : "Create workspace"}
      </Btn>
    </form>
  );
}
