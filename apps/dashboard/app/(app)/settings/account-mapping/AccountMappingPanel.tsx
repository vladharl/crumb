"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown, Ic } from "@crumb/ui";
import { createAccount, renameAccount, deleteAccount, reassignUser, importAccountsCsv } from "./actions";

export type UserView = { id: string; email: string; name: string };
export type AccountView = { id: string; name: string; users: UserView[] };

export function AccountMappingPanel({ initial, isManager }: { initial: AccountView[]; isManager: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string } | unknown>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = (await fn()) as { ok: boolean; error?: string };
      if (r && r.ok === false) setError(r.error ?? "Something went wrong. Try again.");
      else { after?.(); router.refresh(); }
    });
  };

  function add() {
    if (!newName.trim()) return;
    const fd = new FormData(); fd.set("name", newName);
    run(() => createAccount(fd), () => setNewName(""));
  }

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setNotice(null);
    file.text().then(text => {
      startTransition(async () => {
        const r = await importAccountsCsv(text);
        if (!r.ok) setError(r.error);
        else setNotice(`Imported: ${r.accountsCreated} new account(s), ${r.usersCreated} new user(s), ${r.usersUpdated} updated, ${r.skipped} skipped.`);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      });
    });
  }

  return (
    <div className="col gap-4">
      {isManager && (
        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
          <input
            className="input minw-relax"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") add(); }}
            aria-label="New account name"
            placeholder="New account name"
            style={{ flex: 1, minWidth: 200 }}
          />
          <Btn variant="primary" icon={<Ic.plus style={{ width: 11, height: 11 }} />} onClick={add} disabled={pending || !newName.trim()}>Add account</Btn>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onImportFile} style={{ display: "none" }} />
          <Btn variant="ghost" onClick={() => fileRef.current?.click()} disabled={pending}>Import CSV</Btn>
          <a href="/settings/account-mapping/export" className="btn ghost" style={{ textDecoration: "none" }}>
            <Ic.doc style={{ width: 12, height: 12 }} />Export
          </a>
        </div>
      )}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      {notice && <span className="text-xs muted">{notice}</span>}

      {initial.length === 0 ? (
        <p className="text-sm muted" style={{ margin: 0 }}>No accounts yet. Add one above, import a CSV, or let them arrive via the widget.</p>
      ) : (
        <div className="col gap-2">
          {initial.map(acc => (
            <div key={acc.id} style={{ border: "var(--border)", borderRadius: "var(--r-sm)", padding: "10px 12px" }} className="col gap-2">
              <div className="row between center" style={{ gap: 12, flexWrap: "wrap" }}>
                {editing?.id === acc.id ? (
                  <div className="row gap-2 center" style={{ flex: 1 }}>
                    <input
                      className="input"
                      aria-label="Account name"
                      value={editing.name}
                      onChange={e => setEditing({ id: acc.id, name: e.target.value })}
                      style={{ flex: 1 }}
                      autoFocus
                    />
                    <Btn sm variant="primary" onClick={() => run(() => renameAccount(acc.id, editing!.name), () => setEditing(null))} disabled={pending}>Save</Btn>
                    <Btn sm variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => setExpanded(s => ({ ...s, [acc.id]: !s[acc.id] }))}
                      style={{ background: "none", border: 0, padding: "4px 0", margin: "-4px 0", cursor: "pointer", color: "var(--ink)", display: "flex", alignItems: "center", gap: 8, flex: 1, textAlign: "left" }}
                    >
                      <Ic.chevR style={{ width: 12, height: 12, transform: expanded[acc.id] ? "rotate(90deg)" : "none", transition: "transform 120ms ease", color: "var(--mute)" }} />
                      <span className="fw-med text-md">{acc.name}</span>
                      <span className="text-xs muted">{acc.users.length} {acc.users.length === 1 ? "user" : "users"}</span>
                    </button>
                    {isManager && (
                      <div className="row gap-2 center">
                        <Btn sm variant="ghost" onClick={() => setEditing({ id: acc.id, name: acc.name })}>Rename</Btn>
                        {confirmDelete === acc.id ? (
                          <>
                            <span className="text-xs" style={{ color: "var(--err-text)" }}>Delete account?</span>
                            <Btn sm variant="danger" onClick={() => run(() => deleteAccount(acc.id), () => setConfirmDelete(null))} disabled={pending}>Delete</Btn>
                            <Btn sm variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
                          </>
                        ) : (
                          <Btn sm variant="ghost" onClick={() => { setConfirmDelete(acc.id); setError(null); }}>Delete</Btn>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {expanded[acc.id] && (
                <div className="col gap-1" style={{ paddingLeft: 20 }}>
                  {acc.users.length === 0 ? (
                    <span className="text-xs muted">No users on this account.</span>
                  ) : acc.users.map(u => (
                    <div key={u.id} className="row between center" style={{ gap: 12, flexWrap: "wrap" }}>
                      <span className="text-sm">{u.name} <span className="muted">· {u.email}</span></span>
                      {isManager && initial.length > 1 && (
                        <Dropdown
                          size="sm"
                          ariaLabel={`Move ${u.email} to another account`}
                          placeholder="Move to…"
                          value={null}
                          disabled={pending}
                          searchable={initial.length > 8}
                          onChange={to => { if (to) run(() => reassignUser(u.id, to)); }}
                          options={initial.filter(a => a.id !== acc.id).map(a => ({ value: a.id, label: a.name }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
