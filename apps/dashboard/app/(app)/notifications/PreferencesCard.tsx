"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHead, Field, Switch } from "@crumb/ui";
import { savePreferences, type PrefsInput } from "./actions";

export type PrefsState = {
  digestFrequency: "off" | "daily" | "weekly";
  newSubmissionRealtime: boolean;
  assignedRealtime: boolean;
  replyRealtime: boolean;
  mentionRealtime: boolean;
  delivery: "email" | "slack" | "none";
};

type ToggleRow = {
  key: Exclude<keyof PrefsState, "digestFrequency" | "delivery">;
  label: string;
};

// One row per nudge lib/vendor-notify.ts actually sends.
const ROWS: ToggleRow[] = [
  { key: "newSubmissionRealtime", label: "New feedback" },
  { key: "assignedRealtime",      label: "Assigned to me" },
  { key: "replyRealtime",         label: "Customer reply" },
  { key: "mentionRealtime",       label: "Mention" },
];

export function PreferencesCard({
  initial,
  slackInstalled,
}: {
  initial: PrefsState;
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
        <Field label="Email digest">
          <div className="seg" style={{ width: "100%" }}>
            {(["off", "daily", "weekly"] as const).map(v => (
              <button
                key={v}
                aria-selected={prefs.digestFrequency === v}
                aria-pressed={prefs.digestFrequency === v}
                onClick={() => update("digestFrequency", v)}
                disabled={pending}
              >
                {v === "off" ? "Off" : v === "daily" ? "Daily" : "Weekly"}
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
                  aria-pressed={prefs.delivery === v}
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
          return (
            <div key={r.key} className="row gap-3 center">
              {/* The switch is the button (no button around it). Clicks wait
                  out a save in flight, as the old disabled wrapper did. */}
              <Switch on={value} label={r.label} onClick={() => { if (!pending) update(r.key, !value); }} />
              <span className="text-sm grow">{r.label}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
