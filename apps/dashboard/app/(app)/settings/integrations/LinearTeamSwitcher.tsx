"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown } from "@crumb/ui";
import { listLinearTeams, setLinearDefaultTeam } from "./actions";

// Admin-only "Change team" affordance on the connected Linear card. Lazy-loads
// the team list on first open (one Linear API call), then writes the choice
// via setLinearDefaultTeam. Disconnect/reconnect is no longer required just to
// move where this workspace's tickets land.
export function LinearTeamSwitcher({ currentTeamId }: { currentTeamId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function load() {
    setOpen(true);
    if (teams.length) return;
    setLoading(true);
    setError(null);
    const r = await listLinearTeams();
    setLoading(false);
    if (r.ok) setTeams(r.teams);
    else setError(r.error === "revoked"
      ? "Linear disconnected this app. Reconnect it above."
      : "Couldn't load teams from Linear.");
  }

  function choose(teamId: string) {
    const t = teams.find(x => x.id === teamId);
    if (!t || t.id === currentTeamId) { setOpen(false); return; }
    startTransition(async () => {
      const r = await setLinearDefaultTeam(t.id, t.name);
      if (r.ok) { setOpen(false); router.refresh(); }
      else setError("Couldn't switch team. Please try again.");
    });
  }

  if (!open) {
    return <Btn sm onClick={load}>Change team</Btn>;
  }

  return (
    <div className="col gap-1" style={{ maxWidth: 320 }}>
      {loading ? (
        <span className="text-sm muted">Loading teams…</span>
      ) : error ? (
        <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>
      ) : (
        <Dropdown
          ariaLabel="Linear team"
          value={currentTeamId ?? ""}
          onChange={choose}
          disabled={pending}
          searchable={teams.length > 8}
          buttonStyle={{ width: "100%" }}
          options={teams.map(t => ({ value: t.id, label: `${t.name} (${t.key})` }))}
        />
      )}
    </div>
  );
}
