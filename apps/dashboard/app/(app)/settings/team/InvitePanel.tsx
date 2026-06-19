"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown, Field, Ic, Pill } from "@crumb/ui";
import { changeRole, inviteTeammate, removeMember, resendInvite } from "./actions";

type Result =
  | { kind: "idle" }
  | { kind: "sent"; email: string; link: string }
  | { kind: "error"; message: string };

export function InvitePanel({ canInvite }: { canInvite: boolean }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  if (!canInvite) {
    return (
      <Btn sm disabled icon={<Ic.plus style={{ width: 11, height: 11 }} />}>Invite</Btn>
    );
  }

  if (!open) {
    return (
      <Btn sm variant="primary" icon={<Ic.plus style={{ width: 11, height: 11 }} />} onClick={() => setOpen(true)}>
        Invite
      </Btn>
    );
  }

  return (
    <div className="invite-panel" style={{
      border: "var(--border)",
      borderRadius: "var(--r-md)",
      padding: 14,
      background: "var(--surface)",
      minWidth: 340,
      maxWidth: 480,
    }}>
      {result.kind === "sent" ? (
        <div className="col gap-3">
          <div className="col gap-1">
            <span className="serif text-md">Invite link for {result.email}</span>
            <span className="text-xs muted">
              Share this with them directly. They'll be signed in on click. The link expires in 7 days.
            </span>
          </div>
          <div className="row gap-2 center" style={{
            border: "var(--border)",
            borderRadius: "var(--r-sm)",
            padding: "8px 10px",
            background: "var(--bone-2)",
          }}>
            <span className="mono text-xs" style={{ flex: 1, wordBreak: "break-all", lineHeight: 1.4 }}>{result.link}</span>
            <Btn sm variant="ghost" icon={<Ic.copy style={{ width: 11, height: 11 }} />} onClick={() => navigator.clipboard.writeText(result.link).catch(() => {})}>
              Copy
            </Btn>
          </div>
          <div className="row gap-2">
            <Btn sm onClick={() => setResult({ kind: "idle" })}>Invite another</Btn>
            <Btn sm variant="ghost" onClick={() => { setOpen(false); setResult({ kind: "idle" }); }}>Close</Btn>
          </div>
        </div>
      ) : (
        <form
          className="col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            startTransition(async () => {
              const res = await inviteTeammate(form);
              if (res.ok) setResult({ kind: "sent", email: res.email, link: res.link });
              else setResult({ kind: "error", message: res.error });
            });
          }}
        >
          <Field label="Email">
            <input name="email" type="email" required autoFocus className="input" placeholder="teammate@yourcompany.com" disabled={pending} />
          </Field>
          <Field label="Name">
            <input name="name" required className="input" placeholder="First Last" disabled={pending} />
          </Field>
          <Field label="Role">
            <div className="seg" style={{ width: "100%" }}>
              <label style={{ flex: 1, textAlign: "center", padding: "5px 6px", cursor: "pointer" }}>
                <input type="radio" name="role" value="admin" style={{ display: "none" }} /> Admin
              </label>
              <label style={{ flex: 1, textAlign: "center", padding: "5px 6px", cursor: "pointer" }}>
                <input type="radio" name="role" value="pm" defaultChecked style={{ display: "none" }} /> PM
              </label>
              <label style={{ flex: 1, textAlign: "center", padding: "5px 6px", cursor: "pointer" }}>
                <input type="radio" name="role" value="viewer" style={{ display: "none" }} /> Viewer
              </label>
            </div>
          </Field>

          {result.kind === "error" && (
            <div className="text-xs" style={{ color: "var(--err-text)" }}>{result.message}</div>
          )}

          <div className="row gap-2">
            <Btn sm variant="primary" icon={<Ic.send style={{ width: 11, height: 11 }} />} disabled={pending}>
              {pending ? "Inviting…" : "Send invite"}
            </Btn>
            <Btn sm variant="ghost" onClick={() => { setOpen(false); setResult({ kind: "idle" }); }} disabled={pending}>Cancel</Btn>
          </div>
          <Pill>The invite link is printed to the dashboard's stdout too.</Pill>
        </form>
      )}
    </div>
  );
}

export function RoleSelect({ id, role, isMe }: { id: string; role: string; isMe: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(role);

  if (isMe) {
    return <span className="text-sm">{role === "admin" ? "Admin" : role === "viewer" ? "Viewer" : "PM"}</span>;
  }

  return (
    <div className="col gap-1" style={{ minWidth: 0 }}>
      <Dropdown
        size="sm"
        ariaLabel="Change role"
        value={value}
        disabled={pending}
        onChange={(next) => {
          const prev = value;
          setValue(next);
          setError(null);
          startTransition(async () => {
            const res = await changeRole(id, next);
            if (!res.ok) {
              setValue(prev);
              setError(res.error);
            } else {
              router.refresh();
            }
          });
        }}
        options={[
          { value: "admin", label: "Admin" },
          { value: "pm", label: "PM" },
          { value: "viewer", label: "Viewer" },
        ]}
      />
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

export function RemoveButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <Btn sm variant="ghost" disabled={pending} onClick={() => setConfirming(true)}
        icon={<Ic.x style={{ width: 11, height: 11 }} />}>
        Remove
      </Btn>
    );
  }

  return (
    <div className="row gap-1 center">
      <span className="text-xs muted">Remove {name}?</span>
      <Btn sm variant="primary" disabled={pending} onClick={() => {
        setError(null);
        startTransition(async () => {
          const res = await removeMember(id);
          if (res.ok) router.refresh();
          else { setError(res.error); setConfirming(false); }
        });
      }}>{pending ? "…" : "Yes"}</Btn>
      <Btn sm variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>No</Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

export function ResendButton({ id }: { id: string }) {
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  if (result.kind === "sent") {
    return (
      <div className="row gap-2 center" style={{ minWidth: 0 }}>
        <input
          readOnly
          value={result.link}
          className="input mono text-xs"
          style={{ flex: 1, padding: "2px 6px", height: 22 }}
          onFocus={e => e.currentTarget.select()}
        />
        <Btn sm variant="ghost" icon={<Ic.copy style={{ width: 11, height: 11 }} />}
          onClick={() => navigator.clipboard.writeText(result.link).catch(() => {})}>
          Copy
        </Btn>
      </div>
    );
  }
  return (
    <Btn sm variant="ghost" disabled={pending} onClick={() => {
      startTransition(async () => {
        const res = await resendInvite(id);
        if (res.ok) setResult({ kind: "sent", email: res.email, link: res.link });
        else setResult({ kind: "error", message: res.error });
      });
    }}>
      {pending ? "…" : "Get link"}
    </Btn>
  );
}
