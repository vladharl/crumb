"use client";

import { useState, useTransition } from "react";
import { Card, CardHead, Switch } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { CopySnippetButton } from "../install/CopySnippetButton";
import { setPublicPagesEnabled } from "./actions";

// The opt-in for the public roadmap and changelog (app/[slug]), and once it's
// on, the two links to share (none while the workspace's address is taken).
export function PublicPagesCard({ enabled, isAdmin, addressTaken, roadmapUrl, changelogUrl }: {
  enabled: boolean;
  isAdmin: boolean;
  addressTaken: boolean;
  roadmapUrl: string;
  changelogUrl: string;
}) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Non-admins get a real disabled switch (dimmed, announced as unavailable).
  // While a save is in flight it only dims and ignores clicks, keeping focus.
  const toggle = () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await setPublicPagesEnabled(!on);
      if (res.ok) setOn(!on);
      else setError(errorMessage(res.error));
    });
  };

  return (
    <Card>
      <CardHead title="Public pages" />
      <div className="card-body col gap-4">
        <p className="text-sm note">
          A read-only roadmap and changelog anyone with the link can open, no sign-in needed. They show only
          the initiatives you&apos;ve made public (name, description, status and column, plus the ones that
          shipped lately) and the changelog entries you&apos;ve published as public, never customer names,
          accounts, feedback or counts. Visitors can follow by email: they confirm from their inbox first,
          and every email has a link to stop.
        </p>
        <label className="row gap-3 center" style={{ opacity: pending ? 0.55 : 1, cursor: isAdmin ? "pointer" : "default" }}>
          <Switch on={on} onClick={toggle} disabled={!isAdmin} />
          <span className="text-sm fw-med">Publish the roadmap and changelog</span>
        </label>
        {!isAdmin && <p className="text-xs muted note">Only workspace admins can change this.</p>}
        {addressTaken ? (
          <p className="text-sm note">
            Your workspace&apos;s address is reserved for Crumb&apos;s own pages, so the roadmap and
            changelog can&apos;t be served there. They need a different workspace address.
          </p>
        ) : on && (
          <div className="col gap-2">
            {([["Roadmap", roadmapUrl], ["Changelog", changelogUrl]] as const).map(([label, url]) => (
              <div key={label} className="row gap-3 center">
                <span className="eyebrow" style={{ width: 72, flexShrink: 0 }}>{label}</span>
                <a href={url} target="_blank" rel="noreferrer" className="mono text-xs truncate grow" style={{ color: "var(--text)" }}>{url}</a>
                <CopySnippetButton snippet={url} label={`Copy the ${label.toLowerCase()} link`} />
              </div>
            ))}
          </div>
        )}
        {error && (
          <div role="alert" className="text-sm" style={{
            background: "var(--err-bg)",
            border: "1px solid var(--err-border)",
            color: "var(--err-text)",
            borderRadius: "var(--r-sm)",
            padding: "8px 10px",
          }}>{error}</div>
        )}
      </div>
    </Card>
  );
}
