"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Field, Ic } from "@crumb/ui";
import { bootstrapWorkspace } from "./actions";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function OnboardForm() {
  const router = useRouter();
  const [workspaceName, setWorkspaceName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const effectiveSlug = slugTouched ? slug : slugify(workspaceName);

  return (
    <form
      className="col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const form = new FormData(e.currentTarget);
        // make sure the auto-derived slug gets submitted when the user
        // never touched the input
        form.set("slug", effectiveSlug);
        startTransition(async () => {
          const res = await bootstrapWorkspace(form);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          // Cookie was set by the action's response; navigate now that the
          // browser has it.
          router.replace("/inbox");
          router.refresh();
        });
      }}
    >
      <Field label="Workspace name" help="Shown to your customers and on outbound emails.">
        <input
          name="workspaceName"
          required
          autoFocus
          className="input"
          placeholder="Acme Inc."
          value={workspaceName}
          onChange={e => setWorkspaceName(e.target.value)}
          disabled={pending}
        />
      </Field>

      <Field label="Slug" help="Used as the widget's workspace identifier. Lowercase letters, numbers, hyphens.">
        <input
          name="slug"
          required
          className="input mono"
          placeholder="acme"
          value={effectiveSlug}
          onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
          disabled={pending}
        />
      </Field>

      <hr className="divider" />

      <Field label="Your name">
        <input
          name="adminName"
          required
          className="input"
          placeholder="Jane Doe"
          value={adminName}
          onChange={e => setAdminName(e.target.value)}
          disabled={pending}
        />
      </Field>

      <Field label="Your email" help="You can sign in with this via magic link later.">
        <input
          name="adminEmail"
          type="email"
          required
          autoComplete="email"
          className="input"
          placeholder="you@acme.com"
          value={adminEmail}
          onChange={e => setAdminEmail(e.target.value)}
          disabled={pending}
        />
      </Field>

      {error && (
        <div className="text-sm" style={{
          background: "var(--err-bg)",
          border: "1px solid var(--err-border)",
          color: "var(--err-text)",
          borderRadius: "var(--r-sm)",
          padding: "10px 12px",
        }}>{error}</div>
      )}

      <Btn variant="primary" lg full icon={<Ic.check style={{ width: 12, height: 12 }} />} disabled={pending}>
        {pending ? "Setting up…" : "Create workspace & sign in"}
      </Btn>
    </form>
  );
}
