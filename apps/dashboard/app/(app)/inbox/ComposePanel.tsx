"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Dropdown, Field, Ic } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { composeOnBehalf } from "./compose-actions";

const TYPES: Array<{ key: "bug" | "idea" | "question"; label: string }> = [
  { key: "bug", label: "Bug" },
  { key: "idea", label: "Idea" },
  { key: "question", label: "Question" },
];

export function ComposePanel({ knownAccounts }: { knownAccounts: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const [submitterName, setSubmitterName] = useState("");
  const [type, setType] = useState<typeof TYPES[number]["key"]>("idea");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The command palette's "Compose" lands on /inbox?compose=1: open, then drop
  // the param so a refresh or Back doesn't open it again.
  const searchParams = useSearchParams();
  useEffect(() => {
    if (searchParams.get("compose") !== "1") return;
    setOpen(true);
    const params = new URLSearchParams(window.location.search);
    params.delete("compose");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [searchParams]);

  // Closing keeps the draft — only a successful create clears it, so a stray
  // scrim click or Escape can't eat a half-typed email transcription.
  function close() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

  function reset() {
    setOpen(false);
    setAccountName("");
    setSubmitterEmail("");
    setSubmitterName("");
    setType("idea");
    setTitle("");
    setBody("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await composeOnBehalf({
        accountName, submitterEmail, submitterName, type, title, body,
      });
      if (res.ok) {
        reset();
        router.push(`/thread/${res.shortId}`);
      } else {
        setError(errorMessage(res.error));
      }
    });
  }

  return (
    <>
      <Btn variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />} onClick={() => setOpen(true)}>
        Compose
      </Btn>
      {open && (
        <ComposeModal
          onClose={close}
          pending={pending}
          error={error}
          submit={submit}
          fields={{
            accountName, setAccountName,
            submitterEmail, setSubmitterEmail,
            submitterName, setSubmitterName,
            type, setType,
            title, setTitle,
            body, setBody,
          }}
          knownAccounts={knownAccounts}
        />
      )}
    </>
  );
}

function ComposeModal({
  onClose, pending, error, submit, fields, knownAccounts,
}: {
  onClose: () => void;
  pending: boolean;
  error: string | null;
  submit: () => void;
  fields: {
    accountName: string; setAccountName: (v: string) => void;
    submitterEmail: string; setSubmitterEmail: (v: string) => void;
    submitterName: string; setSubmitterName: (v: string) => void;
    type: typeof TYPES[number]["key"]; setType: (v: typeof TYPES[number]["key"]) => void;
    title: string; setTitle: (v: string) => void;
    body: string; setBody: (v: string) => void;
  };
  knownAccounts: string[];
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Account names match ignoring case on the server (lib/compose.ts), so say
  // up front which account the item lands in, and when it starts a new one.
  const typed = fields.accountName.trim();
  const existing = typed ? knownAccounts.find(n => n.toLowerCase() === typed.toLowerCase()) : undefined;
  const accountRef = useRef<HTMLInputElement>(null);
  // Picking one removes the picker with the warning: focus goes back to the
  // field, after the picker has put it on its own button.
  function pickAccount(name: string) {
    fields.setAccountName(name);
    requestAnimationFrame(() => accountRef.current?.focus());
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compose on behalf"
      className="sheet-scrim"
      onClick={onClose}
    >
      <div
        className="sheet"
        onClick={e => e.stopPropagation()}
        style={{ padding: 20 }}
      >
        <div className="row between center" style={{ marginBottom: 8 }}>
          <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>Compose on behalf</h3>
          <button
            aria-label="Close"
            onClick={onClose}
            disabled={pending}
            style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--mute)" }}
          >
            <Ic.x style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <p className="text-xs muted" style={{ margin: "0 0 14px", lineHeight: 1.55 }}>
          For when a customer emails or calls instead of using the widget. The item appears as if they submitted it themselves; reply threads + notifications flow to their email.
        </p>

        <div className="col gap-3">
          <Field label="Customer account">
            <input
              ref={accountRef}
              className="input"
              list="known-accounts"
              placeholder="Acme Co"
              value={fields.accountName}
              onChange={e => fields.setAccountName(e.target.value)}
              disabled={pending}
              autoFocus
              aria-label="Customer account"
              aria-describedby={typed && !existing ? "compose-new-account" : undefined}
            />
            <datalist id="known-accounts">
              {knownAccounts.map(n => <option key={n} value={n} />)}
            </datalist>
            {typed && !existing && (
              <div className="row gap-2 center" style={{ flexWrap: "wrap", marginTop: 6 }}>
                <span id="compose-new-account" className="text-xs fw-med">
                  This creates a new account, {typed}.
                </span>
                {knownAccounts.length > 0 && (
                  <Dropdown
                    size="sm"
                    ariaLabel="Pick an existing account"
                    placeholder="Pick an existing one"
                    value={null}
                    disabled={pending}
                    searchable={knownAccounts.length > 8}
                    onChange={pickAccount}
                    options={knownAccounts.map(n => ({ value: n, label: n }))}
                  />
                )}
              </div>
            )}
            {existing && existing !== typed && (
              <span className="text-xs muted" style={{ marginTop: 6 }}>Adds to {existing}.</span>
            )}
          </Field>

          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            <Field label="Submitter email">
              <input
                className="input"
                type="email"
                placeholder="maya@acme.co"
                value={fields.submitterEmail}
                onChange={e => fields.setSubmitterEmail(e.target.value)}
                disabled={pending}
              />
            </Field>
            <Field label="Submitter name (optional)">
              <input
                className="input"
                placeholder="Maya"
                value={fields.submitterName}
                onChange={e => fields.setSubmitterName(e.target.value)}
                disabled={pending}
              />
            </Field>
          </div>

          <Field label="Type">
            <div className="seg" style={{ width: "100%" }}>
              {TYPES.map(t => (
                <button key={t.key} aria-selected={fields.type === t.key} onClick={() => fields.setType(t.key)} style={{ flex: 1 }}>
                  {t.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Title">
            <input
              className="input"
              placeholder="One line: what's the gist?"
              value={fields.title}
              onChange={e => fields.setTitle(e.target.value)}
              disabled={pending}
            />
          </Field>

          <Field label="Details (optional)">
            <textarea
              className="input"
              rows={4}
              placeholder="What did they say? Paste the email body here."
              value={fields.body}
              onChange={e => fields.setBody(e.target.value)}
              disabled={pending}
            />
          </Field>

          {error && (
            <div className="text-sm" style={{
              background: "var(--err-bg)",
              border: "1px solid var(--err-border)",
              color: "var(--err-text)",
              borderRadius: "var(--r-sm)",
              padding: "8px 10px",
            }}>{error}</div>
          )}

          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose} disabled={pending}>Cancel</Btn>
            <Btn variant="primary" icon={<Ic.send style={{ width: 12, height: 12 }} />} onClick={submit} disabled={pending}>
              {pending ? "Creating…" : "Create item"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
