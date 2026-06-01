"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Card, CardHead, Dropdown, Ic, Pill } from "@crumb/ui";
import { createItemFromCapture, dismissCapture } from "../captures/actions";
import type { CaptureRow, AccountOption } from "../captures/CapturesList";

const TYPES = [
  { value: "question", label: "Question" },
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
];

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? "").trim().slice(0, 160);
}

/**
 * Pending captures (forwarded email / Slack / extension) surfaced at the top of
 * the Inbox. Each shows its source and, when the customer is unknown, an inline
 * account picker that turns it into a real feedback item via the existing
 * createItemFromCapture flow. Renders nothing when there's nothing to triage.
 */
export function CaptureTriage({ captures, accounts, canWrite }: { captures: CaptureRow[]; accounts: AccountOption[]; canWrite: boolean }) {
  if (captures.length === 0) return null;
  return (
    <Card>
      <CardHead
        title={`Needs triage · ${captures.length}`}
        after={<span className="text-xs muted">Forwarded from email, Slack, or the extension. Map each to a customer.</span>}
      />
      <div>
        {captures.map(c => (
          <CaptureRowInline key={c.id} capture={c} accounts={accounts} canWrite={canWrite} />
        ))}
      </div>
    </Card>
  );
}

function CaptureRowInline({ capture, accounts, canWrite }: { capture: CaptureRow; accounts: AccountOption[]; canWrite: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [accountName, setAccountName] = useState(capture.suggestedAccountName ?? "");
  const [type, setType] = useState("question");
  const [title, setTitle] = useState(capture.subject?.trim() || firstLine(capture.body) || "");

  // Account picker: existing accounts + the currently typed/created name so the
  // trigger shows it. composeItem upserts by name, so we pass the name through.
  const accountOpts = accounts.map(a => ({ value: a.name, label: a.name }));
  if (accountName && !accountOpts.some(o => o.value === accountName)) {
    accountOpts.unshift({ value: accountName, label: accountName });
  }

  function create() {
    setError(null);
    start(async () => {
      const r = await createItemFromCapture({
        captureId: capture.id,
        accountName,
        submitterEmail: capture.fromEmail ?? "",
        submitterName: capture.fromName ?? undefined,
        type,
        title,
        body: capture.body,
      });
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  function dismiss() {
    setError(null);
    start(async () => {
      const r = await dismissCapture(capture.id);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <div style={{ padding: "14px 18px", borderTop: "var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Pill ring><Ic.filter style={{ width: 10, height: 10 }} /> {capture.source}</Pill>
        <span className="text-sm fw-med">{capture.fromName || capture.fromEmail || "Unknown sender"}</span>
        {capture.fromEmail && capture.fromName && <span className="text-xs muted">{capture.fromEmail}</span>}
        {!accountName && <Pill style={{ color: "var(--rust)" }}>Unknown customer</Pill>}
        {capture.suggestedAccountName && (
          <span className="text-xs row gap-1 center" style={{ color: "var(--accent-deep)" }} title={`${Math.round((capture.suggestedConfidence ?? 0) * 100)}% confidence`}>
            <Ic.sparkle style={{ width: 11, height: 11 }} /> suggests {capture.suggestedAccountName}
          </span>
        )}
      </div>

      {capture.body && (
        <p className="text-sm muted" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 64, overflow: "hidden" }}>
          {capture.body.slice(0, 300)}
        </p>
      )}

      {canWrite ? (
        <>
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            <Dropdown
              ariaLabel="Assign account"
              placeholder="Assign account…"
              value={accountName || null}
              allowCreate
              searchable
              onChange={setAccountName}
              onCreate={setAccountName}
              options={accountOpts}
              buttonStyle={{ minWidth: 180 }}
            />
            <Dropdown
              ariaLabel="Type"
              size="sm"
              value={type}
              onChange={setType}
              options={TYPES}
            />
            <input
              className="input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Title"
              disabled={pending}
              style={{ flex: "1 1 220px", minWidth: 160 }}
            />
            <Btn sm variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />} onClick={create} disabled={pending || !accountName.trim() || !title.trim()}>
              {pending ? "Creating…" : "Create item"}
            </Btn>
            <Btn sm onClick={dismiss} disabled={pending}>Dismiss</Btn>
          </div>
          {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
        </>
      ) : (
        <span className="text-xs muted">Only admins and PMs can triage captures.</span>
      )}
    </div>
  );
}
