"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Field, Ic } from "@crumb/ui";
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

  if (!open) {
    return (
      <Btn variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />} onClick={() => setOpen(true)}>
        Compose
      </Btn>
    );
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
        setError(res.error);
      }
    });
  }

  return (
    <div style={{
      border: "var(--border)",
      borderRadius: "var(--r-md)",
      padding: 14,
      background: "var(--surface)",
      maxWidth: 520,
    }}>
      <div className="row gap-2 center" style={{ marginBottom: 10 }}>
        <span className="serif text-md grow">Compose on behalf</span>
        <Btn sm variant="ghost" onClick={reset} disabled={pending}>Cancel</Btn>
      </div>
      <p className="text-xs muted" style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
        For when a customer emails or calls instead of using the widget. The item appears as if they submitted it themselves; reply threads + notifications flow to their email.
      </p>

      <div className="col gap-3">
        <Field label="Customer account">
          <input
            className="input"
            list="known-accounts"
            placeholder="Acme Co"
            value={accountName}
            onChange={e => setAccountName(e.target.value)}
            disabled={pending}
          />
          <datalist id="known-accounts">
            {knownAccounts.map(n => <option key={n} value={n} />)}
          </datalist>
        </Field>

        <div className="row gap-2" style={{ flexWrap: "wrap" }}>
          <Field label="Submitter email">
            <input
              className="input"
              type="email"
              placeholder="maya@acme.co"
              value={submitterEmail}
              onChange={e => setSubmitterEmail(e.target.value)}
              disabled={pending}
            />
          </Field>
          <Field label="Submitter name (optional)">
            <input
              className="input"
              placeholder="Maya"
              value={submitterName}
              onChange={e => setSubmitterName(e.target.value)}
              disabled={pending}
            />
          </Field>
        </div>

        <Field label="Type">
          <div className="seg" style={{ width: "100%" }}>
            {TYPES.map(t => (
              <button key={t.key} aria-selected={type === t.key} onClick={() => setType(t.key)} style={{ flex: 1 }}>
                {t.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Title">
          <input
            className="input"
            placeholder="One line — what's the gist?"
            value={title}
            onChange={e => setTitle(e.target.value)}
            disabled={pending}
          />
        </Field>

        <Field label="Details (optional)">
          <textarea
            className="input"
            rows={3}
            placeholder="What did they say? Paste the email body here."
            value={body}
            onChange={e => setBody(e.target.value)}
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

        <div className="row gap-2">
          <Btn variant="primary" icon={<Ic.send style={{ width: 12, height: 12 }} />} onClick={submit} disabled={pending}>
            {pending ? "Creating…" : "Create item"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
