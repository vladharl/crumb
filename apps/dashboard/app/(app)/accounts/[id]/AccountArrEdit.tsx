"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { setAccountArr } from "../actions";

// Display matches the server `arr()` formatter: $X.XM / $Xk / "Set ARR".
function fmt(cents: number): string {
  if (cents === 0) return "Set ARR";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(1)}M ARR`;
  return `$${Math.round(cents / 100_000)}k ARR`;
}

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

  if (!canEdit) return <Pill solid>{fmt(cents)}</Pill>;

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
      const r = await setAccountArr(accountId, next);
      if (r.ok) { setCents(r.arrCents); router.refresh(); }
      else {
        setCents(prev); // revert
        toast.show({ message: errorMessage(r.error), tone: "error" });
      }
    });
  }

  if (editing) {
    return (
      <span className="row gap-1 center" style={{
        border: "1px solid var(--line)", borderRadius: 999, padding: "2px 10px", background: "var(--paper)",
      }}>
        <span className="muted text-sm">$</span>
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          inputMode="numeric"
          placeholder="ARR in dollars"
          style={{ width: 120, padding: "1px 2px", font: "inherit", fontSize: 13, border: 0, outline: "none", background: "transparent", color: "var(--ink)" }}
        />
      </span>
    );
  }

  return (
    <button
      onClick={open}
      disabled={pending}
      title="Edit ARR"
      style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
    >
      <Pill solid>{fmt(cents)}</Pill>
    </button>
  );
}
