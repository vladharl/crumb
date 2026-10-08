"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Card, CardHead, Dropdown, Ic, Pill } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { createItemFromCapture, dismissCapture, restoreCapture } from "../captures/actions";

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

// The address check composeItem makes (lib/compose.ts).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [accountName, setAccountName] = useState(capture.suggestedAccountName ?? "");
  const [type, setType] = useState("question");
  // Title seeds from a real subject only. We don't pre-fill it with the body —
  // that just duplicated the preview shown below and read like a bug. With no
  // subject the field starts empty and the placeholder asks for a short title.
  const [title, setTitle] = useState(capture.subject?.trim() ?? "");
  // No usable sender address (a Gong call, a Freshdesk ticket, a forward that
  // carried only a name): ask for one. Left blank, createItemFromCapture files
  // it under a placeholder address that is never emailed. Whatever unusable
  // value came in still shows in the header above.
  const askEmail = !EMAIL_RE.test(capture.fromEmail?.trim() ?? "");
  const [email, setEmail] = useState(askEmail ? "" : capture.fromEmail ?? "");

  const noAccount = !accountName.trim();

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
        submitterEmail: email,
        submitterName: capture.fromName ?? undefined,
        type,
        title,
        body: capture.body,
      });
      if (r.ok) {
        router.refresh();
        toast.show({ message: "Added to the inbox." });
      } else setError(errorMessage(r.error));
    });
  }

  async function dismiss() {
    const ok = await confirm({
      title: "Dismiss this capture?",
      body: "It won't become a request. You can undo right after.",
      confirmLabel: "Dismiss",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await dismissCapture(capture.id);
      if (r.ok) {
        router.refresh();
        // The row unmounts on refresh, so undo can't lean on this component's
        // transition — restoreCapture + refresh are safe to fire from the toast.
        toast.show({
          message: "Capture dismissed.",
          action: {
            label: "Undo",
            onClick: () => {
              restoreCapture(capture.id).then(res => {
                if (res.ok) router.refresh();
                else toast.show({ message: "Couldn't restore the capture.", tone: "error" });
              });
            },
          },
        });
      } else setError(errorMessage(r.error));
    });
  }

  return (
    <div style={{ padding: "14px 18px", borderTop: "var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Pill ring><Ic.filter style={{ width: 10, height: 10 }} /> {capture.source}</Pill>
        <span className="text-sm fw-med">{capture.fromName || capture.fromEmail || "Unknown sender"}</span>
        {capture.fromEmail && capture.fromName && <span className="text-xs muted">{capture.fromEmail}</span>}
        {capture.suggestedAccountName && noAccount && (
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
          <div className="row gap-2 start" style={{ flexWrap: "wrap" }}>
            {/* Account picker carries the "Unknown customer" alarm itself, so the
                problem and its fix sit in one place instead of across the row. */}
            <div className="col gap-1" style={{ flex: "0 1 220px", minWidth: 180 }}>
              <Dropdown
                ariaLabel="Assign account"
                placeholder="Map to a customer…"
                value={accountName || null}
                allowCreate
                searchable
                onChange={setAccountName}
                onCreate={setAccountName}
                options={accountOpts}
              />
              {noAccount && (
                <span className="text-2xs" style={{ color: "var(--err-text)" }}>
                  Unknown customer. Map it to a customer to continue.
                </span>
              )}
            </div>
            {askEmail && (
              <input
                className="input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Customer email (optional)"
                aria-label="Customer email"
                autoComplete="off"
                disabled={pending}
                style={{ flex: "0 1 220px", minWidth: 160 }}
              />
            )}
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
              placeholder="Give it a short title"
              aria-label="Request title"
              disabled={pending}
              style={{ flex: "1 1 220px", minWidth: 160 }}
            />
            <Btn sm variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />} onClick={create} disabled={pending || noAccount || !title.trim()}>
              {pending ? "Creating…" : "Create request"}
            </Btn>
            {/* A hairline + ghost styling separate the lesser, guarded action
                from the primary one so a fast click doesn't drop a capture. */}
            <span aria-hidden style={{ alignSelf: "stretch", width: 1, background: "var(--hair)", margin: "0 2px" }} />
            <Btn sm variant="ghost" onClick={dismiss} disabled={pending}>Dismiss</Btn>
          </div>
          {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
        </>
      ) : (
        <span className="text-xs muted">Only admins and PMs can triage captures.</span>
      )}
    </div>
  );
}
