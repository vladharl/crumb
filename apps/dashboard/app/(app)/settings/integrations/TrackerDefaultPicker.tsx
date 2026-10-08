"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { listProviderTargets, updateProviderDefault } from "@/app/(app)/thread/[shortId]/actions";

type Provider = "linear" | "jira" | "github";

const NAME: Record<Provider, string> = { linear: "Linear", jira: "Jira", github: "GitHub" };
const WHAT: Record<Provider, { one: string; many: string }> = {
  linear: { one: "team", many: "teams" },
  jira: { one: "project", many: "projects" },
  github: { one: "repository", many: "repositories" },
};

// Admin-only, on a connected tracker's card: the team, project or repository
// new tickets start in (the create dialog can pick another). The GitHub one
// also gives AI drafts and Slack sizing a README and file layout to read.
// Loads every page of the list on open; a long one gets a search box.
export function TrackerDefaultPicker({ provider, current }: { provider: Provider; current: string | null }) {
  const router = useRouter();
  const name = NAME[provider];
  const { one, many } = WHAT[provider];
  const [targets, setTargets] = useState<Array<{ id: string; label: string }> | null>(null); // null: picker closed
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The button and the list take turns in one spot; focus follows across, so a
  // keyboard user isn't dropped back at the top of the page.
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(false);
  useEffect(() => {
    if (follow.current) box.current?.querySelector("button")?.focus();
    follow.current = false;
  }, [targets]);

  function show(next: typeof targets) {
    follow.current = true;
    setTargets(next);
  }

  function failed(code: string) {
    // Disconnected: the card says so after a refresh.
    if (code === `${provider}_revoked` || code === `${provider}_not_connected`) router.refresh();
    else if (code === "provider_list_failed") setError(`Couldn't load ${many} from ${name}. Try again in a few minutes.`);
    else if (code.endsWith("_not_found")) setError(`${name} no longer lists that ${one}. Choose another.`);
    else setError(errorMessage(code));
  }

  function load() {
    setError(null);
    startTransition(async () => {
      const r = await listProviderTargets(provider).catch(() => ({ ok: false as const, error: "provider_list_failed" }));
      if (!r.ok) failed(r.error);
      else if (r.targets.length) show(r.targets);
      else setError(`This ${name} connection can't see any ${many} yet.`);
    });
  }

  function choose(id: string) {
    if (id === current) { show(null); return; }
    setError(null);
    startTransition(async () => {
      const r = await updateProviderDefault(provider, id).catch(() => ({ ok: false as const, error: "failed" }));
      if (r.ok) { show(null); router.refresh(); }
      else failed(r.error);
    });
  }

  const errorLine = error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>;
  if (targets) {
    return (
      <div ref={box} className="col gap-1" style={{ minWidth: 240, maxWidth: 360 }}>
        <Dropdown
          ariaLabel={`Default ${name} ${one}`}
          value={current ?? ""}
          placeholder={`Choose a ${one}`}
          onChange={choose}
          disabled={pending}
          searchable={targets.length > 8}
          buttonStyle={{ width: "100%" }}
          options={targets.map(t => ({ value: t.id, label: t.label }))}
        />
        {errorLine}
      </div>
    );
  }
  return (
    <div ref={box} className="row gap-2 center">
      <Btn sm onClick={load} disabled={pending}>
        {pending ? `Loading ${many}…` : `${current ? "Change" : "Choose"} default ${one}`}
      </Btn>
      {errorLine}
    </div>
  );
}
