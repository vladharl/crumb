"use client";

import { useId } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { followPublic, type FollowState } from "./actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button className="btn primary" disabled={pending}>{label}</button>;
}

// An email box that follows one initiative (or every update, with no
// initiative). Works before hydration too: the form posts to the server action.
export function FollowForm({ slug, initiativeId, label, cta }: {
  slug: string;
  initiativeId: string | null;
  label: string;
  cta: string;
}) {
  const [state, action] = useFormState<FollowState, FormData>(followPublic, null);
  const id = useId();
  return (
    <form action={action} className="col gap-2">
      <input type="hidden" name="slug" value={slug} />
      {initiativeId && <input type="hidden" name="initiative" value={initiativeId} />}
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="row gap-2">
        <input
          id={id}
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          placeholder="you@company.com"
          className="input"
          style={{ minWidth: 0 }}
          aria-describedby={`${id}-status`}
        />
        <Submit label={cta} />
      </div>
      <p
        id={`${id}-status`}
        role="status"
        className="text-xs"
        style={{ margin: 0, color: state && !state.ok ? "var(--err-text)" : "var(--text)" }}
      >
        {state?.message}
      </p>
    </form>
  );
}
