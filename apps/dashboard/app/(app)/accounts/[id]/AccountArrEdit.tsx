"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@crumb/ui";
import { runAction } from "@/components/ReplyComposer";
import { useToast } from "@/components/toast";
import { formatArr } from "@/lib/priority";
import { setAccountArr } from "../actions";

// Click-to-edit ARR pill on the account header. Read-only Pill for viewers;
// for admins/PMs it opens a whole-dollars input that saves on blur/Enter.
export function AccountArrEdit({ accountId, arrCents, canEdit }: {
  accountId: string;
  arrCents: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [cents, setCents] = useState(arrCents);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [pending, startTransition] = useTransition();

  if (!canEdit) return <Pill solid>{formatArr(cents, " ARR")}</Pill>;

  function open() {
    setVal(cents > 0 ? String(Math.round(cents / 100)) : "");
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const dollars = Number(val.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) return;
    const next = Math.round(dollars * 100);
    if (next === cents) return;
    const prev = cents;
    setCents(next); // optimistic
    startTransition(async () => {
      // A refusal or a throw (a dropped connection, a stale action after a
      // redeploy) toasts and reverts.
      const r = await runAction(toast, () => setAccountArr(accountId, next));
      if (r) { setCents(r.arrCents); router.refresh(); }
      else setCents(prev);
    });
  }

  if (editing) {
    return (
      <span className="row gap-1 center">
        <span className="muted text-sm">$</span>
        <input
          className="input"
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          inputMode="numeric"
          aria-label="ARR in dollars"
          placeholder="ARR in dollars"
          style={{ width: 140 }}
        />
      </span>
    );
  }

  return (
    <button
      onClick={open}
      disabled={pending}
      title="Edit ARR"
      // The padding lifts the hit area to 24px; the margin keeps the layout.
      style={{ background: "none", border: 0, padding: "3px 0", margin: "-3px 0", borderRadius: 999, cursor: "pointer" }}
    >
      {/* Editors get the action instead of the zero state. */}
      <Pill solid>{cents > 0 ? formatArr(cents, " ARR") : "Set ARR"}</Pill>
    </button>
  );
}
