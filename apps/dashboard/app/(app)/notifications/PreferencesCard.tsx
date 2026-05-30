"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHead, Field, Pill, Switch } from "@crumb/ui";
import { savePreferences, type PrefsInput } from "./actions";

export type PrefsState = {
  digestFrequency: "off" | "daily" | "weekly";
  newSubmissionRealtime: boolean;
  replyRealtime: boolean;
  mentionRealtime: boolean;
  statusChangeRealtime: boolean;
  clusterSuggestionsRealtime: boolean;
  delivery: "email" | "slack" | "none";
};

type ToggleRow = {
  key: Exclude<keyof PrefsState, "digestFrequency" | "delivery">;
  label: string;
  cloudOnly?: boolean;
};

const ROWS: ToggleRow[] = [
  { key: "newSubmissionRealtime", label: "New submission in my accounts" },
  { key: "replyRealtime",         label: "Reply on an item I'm assigned to" },
  { key: "mentionRealtime",       label: "Mention" },
  { key: "statusChangeRealtime",  label: "Status change on items I follow" },
  { key: "clusterSuggestionsRealtime", label: "Cluster suggestions", cloudOnly: true },
];

export function PreferencesCard({
  initial,
  isCloud,
  slackInstalled,
}: {
  initial: PrefsState;
  isCloud: boolean;
  slackInstalled: boolean;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<PrefsState>(initial);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);

  function update<K extends keyof PrefsInput>(key: K, value: PrefsInput[K]) {
    // Optimistic local update so the UI feels instant.
    setPrefs(prev => ({ ...prev, [key]: value as never }));
    startTransition(async () => {
      const res = await savePreferences({ [key]: value } as PrefsInput);
      if (res.ok) setSavedAt(Date.now());
    });
  }

  return (
    <Card>
      <CardHead
        title="Preferences"
        after={savedAt && !pending
          ? <span className="text-xs muted">Saved</span>
          : pending
            ? <span className="text-xs muted">Saving…</span>
            : null}
      />
      <div className="card-body col gap-4">
        <Field label="Daily email digest">
          <div className="seg" style={{ width: "100%" }}>
            {(["off", "daily", "weekly"] as const).map(v => (
              <button
                key={v}
                aria-selected={prefs.digestFrequency === v}
                onClick={() => update("digestFrequency", v)}
                disabled={pending}
              >
                {v === "off" ? "Off" : v === "daily" ? "Daily · 9am" : "Weekly"}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Where to deliver real-time nudges">
          <div className="seg" style={{ width: "100%" }}>
            {(["email", "slack", "none"] as const).map(v => {
              const isSlack = v === "slack";
              // Slack is selectable only when the workspace has installed the
              // integration. When it isn't, the option stays visible but acts
              // as a shortcut to Settings → Integrations instead of a dead
              // click, so vendors can go connect it in one tap.
              const slackBlocked = isSlack && !slackInstalled;
              return (
                <button
                  key={v}
                  aria-selected={prefs.delivery === v}
                  onClick={() => slackBlocked ? router.push("/settings/integrations") : update("delivery", v)}
                  disabled={pending}
                  title={slackBlocked ? "Connect Slack in Settings → Integrations to enable" : undefined}
                >
                  {v === "email" ? "Email" : v === "slack" ? "Slack" : "None"}
                  {slackBlocked && <span style={{ marginLeft: 6, opacity: 0.6 }}>· connect first</span>}
                </button>
              );
            })}
          </div>
        </Field>

        <hr className="divider" />
        <span className="eyebrow">Real-time events</span>

        {ROWS.map(r => {
          const value = prefs[r.key];
          // Hide cluster-suggestions toggle on self-host (Cloud-only feature).
          if (r.cloudOnly && !isCloud) return null;
          return (
            <div key={r.key} className="row gap-3 center">
              <button
                onClick={() => update(r.key, !value)}
                disabled={pending}
                style={{ background: "none", border: 0, padding: 0, cursor: pending ? "default" : "pointer" }}
                aria-pressed={value}
                aria-label={r.label}
              >
                <Switch on={value} />
              </button>
              <span className="text-sm grow">{r.label}</span>
              {r.cloudOnly && <Pill ring ringFill>Cloud</Pill>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
