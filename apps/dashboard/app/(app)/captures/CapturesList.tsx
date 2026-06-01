"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Card, Ic, Pill } from "@crumb/ui";
import { createItemFromCapture, dismissCapture } from "./actions";

export type AccountOption = { id: string; name: string };
export type CaptureRow = {
  id: string;
  source: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  body: string;
  suggestedAccountId: string | null;
  suggestedAccountName: string | null;
  suggestedConfidence: number | null;
  createdAtIso: string;
};

const TYPES = [
  { value: "question", label: "Question" },
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
];

export function CapturesList({
  captures, accounts, canWrite,
}: {
  captures: CaptureRow[];
  accounts: AccountOption[];
  canWrite: boolean;
}) {
  if (captures.length === 0) {
    return (
      <Card>
        <div className="card-body">
          <p className="text-sm muted" style={{ margin: 0 }}>
            Nothing waiting. Forward a customer email to your inbox address, or wire a Slack slash command, and it'll land here for you to map to an account.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <div className="col gap-4">
      {captures.map((c) => (
        <CaptureCard key={c.id} capture={c} accounts={accounts} canWrite={canWrite} />
      ))}
    </div>
  );
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 120);
}

function CaptureCard({ capture, accounts, canWrite }: { capture: CaptureRow; accounts: AccountOption[]; canWrite: boolean }) {
  const router = useRouter();
  const listId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [accountName, setAccountName] = useState(capture.suggestedAccountName ?? "");
  const [submitterEmail, setSubmitterEmail] = useState(capture.fromEmail ?? "");
  const [submitterName, setSubmitterName] = useState(capture.fromName ?? "");
  const [type, setType] = useState("question");
  const [title, setTitle] = useState(capture.subject?.trim() || firstLine(capture.body) || "");
  const [body, setBody] = useState(capture.body);

  function create() {
    setError(null);
    startTransition(async () => {
      const r = await createItemFromCapture({ captureId: capture.id, accountName, submitterEmail, submitterName, type, title, body });
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }
  function dismiss() {
    setError(null);
    startTransition(async () => {
      const r = await dismissCapture(capture.id);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <Card>
      <div className="card-body col gap-3">
        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
          <Pill ring>{capture.source}</Pill>
          <span className="text-sm fw-med">{capture.fromName || capture.fromEmail || "Unknown sender"}</span>
          {capture.fromEmail && capture.fromName && <span className="text-xs muted">{capture.fromEmail}</span>}
          {capture.suggestedAccountName && (
            <span className="text-xs row gap-1 center" style={{ color: "var(--accent-deep)" }} title={`${Math.round((capture.suggestedConfidence ?? 0) * 100)}% confidence`}>
              <Ic.sparkle style={{ width: 11, height: 11 }} /> suggests {capture.suggestedAccountName}
            </span>
          )}
        </div>

        {capture.body && (
          <p className="text-sm muted" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "hidden" }}>
            {capture.body.slice(0, 600)}
          </p>
        )}

        {canWrite ? (
          <>
            <div className="row gap-3" style={{ flexWrap: "wrap" }}>
              <label className="col gap-1" style={{ flex: "1 1 200px", minWidth: 0 }}>
                <span className="eyebrow">Account</span>
                <input className="input" list={listId} value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Map to a customer account" disabled={pending} />
                <datalist id={listId}>{accounts.map((a) => <option key={a.id} value={a.name} />)}</datalist>
              </label>
              <label className="col gap-1" style={{ flex: "1 1 200px", minWidth: 0 }}>
                <span className="eyebrow">Submitter email</span>
                <input className="input" value={submitterEmail} onChange={(e) => setSubmitterEmail(e.target.value)} placeholder="customer@company.com" disabled={pending} />
              </label>
              <label className="col gap-1" style={{ flex: "0 0 120px" }}>
                <span className="eyebrow">Type</span>
                <select className="input" value={type} onChange={(e) => setType(e.target.value)} disabled={pending}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
            </div>
            <label className="col gap-1">
              <span className="eyebrow">Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending} />
            </label>
            <label className="col gap-1">
              <span className="eyebrow">Body</span>
              <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} disabled={pending} />
            </label>
            {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
            <div className="row gap-2">
              <Btn sm variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />} onClick={create} disabled={pending || !accountName.trim() || !title.trim()}>
                {pending ? "Creating…" : "Create item"}
              </Btn>
              <Btn sm onClick={dismiss} disabled={pending}>Dismiss</Btn>
            </div>
          </>
        ) : (
          <span className="text-xs muted">Only admins and PMs can triage captures.</span>
        )}
      </div>
    </Card>
  );
}
