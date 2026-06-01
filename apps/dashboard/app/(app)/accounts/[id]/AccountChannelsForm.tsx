"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Switch } from "@crumb/ui";
import { setAccountChannels, testAccountChannel } from "./actions";

export type ChannelsInitial = {
  slackSet: boolean;
  teamsSet: boolean;
  notifyChatReplies: boolean;
  notifyChatStatus: boolean;
  notifyChatRoadmap: boolean;
};

function errText(e: string): string {
  if (e === "invalid_url") return "Enter a valid https webhook URL (or the host isn't allowed).";
  if (e === "not_connected") return "Save a webhook first.";
  return "Something went wrong.";
}

export function AccountChannelsForm({ accountId, initial, canWrite }: { accountId: string; initial: ChannelsInitial; canWrite: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [slackUrl, setSlackUrl] = useState("");
  const [teamsUrl, setTeamsUrl] = useState("");
  const [replies, setReplies] = useState(initial.notifyChatReplies);
  const [status, setStatus] = useState(initial.notifyChatStatus);
  const [roadmap, setRoadmap] = useState(initial.notifyChatRoadmap);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!canWrite) {
    return <span className="text-xs muted">Only admins and PMs can set customer notification channels.</span>;
  }

  function save() {
    setError(null);
    setMsg(null);
    start(async () => {
      const r = await setAccountChannels(accountId, {
        slackWebhookUrl: slackUrl.trim() || undefined,
        teamsWebhookUrl: teamsUrl.trim() || undefined,
        notifyChatReplies: replies,
        notifyChatStatus: status,
        notifyChatRoadmap: roadmap,
      });
      if (r.ok) { setSlackUrl(""); setTeamsUrl(""); setMsg("Saved."); router.refresh(); }
      else setError(errText(r.error));
    });
  }
  function clearOne(provider: "slack" | "teams") {
    start(async () => {
      const r = await setAccountChannels(accountId, provider === "slack" ? { slackWebhookUrl: null } : { teamsWebhookUrl: null });
      if (r.ok) router.refresh();
    });
  }
  function test(provider: "slack" | "teams") {
    setError(null);
    setMsg(null);
    start(async () => {
      const r = await testAccountChannel(accountId, provider);
      if (r.ok) setMsg("Sent a test card."); else setError(errText(r.error));
    });
  }

  return (
    <div className="col gap-3">
      <div className="col gap-1">
        <span className="eyebrow">Slack channel webhook {initial.slackSet && <span className="text-2xs muted">· configured</span>}</span>
        <input className="input" placeholder={initial.slackSet ? "Replace…" : "https://hooks.slack.com/…"} value={slackUrl} onChange={(e) => setSlackUrl(e.target.value)} disabled={pending} />
        {initial.slackSet && (
          <div className="row gap-2"><button type="button" className="text-2xs muted" style={linkBtn} onClick={() => test("slack")} disabled={pending}>Send test</button><button type="button" className="text-2xs muted" style={linkBtn} onClick={() => clearOne("slack")} disabled={pending}>Remove</button></div>
        )}
      </div>
      <div className="col gap-1">
        <span className="eyebrow">Teams channel webhook {initial.teamsSet && <span className="text-2xs muted">· configured</span>}</span>
        <input className="input" placeholder={initial.teamsSet ? "Replace…" : "https://…webhook.office.com/…"} value={teamsUrl} onChange={(e) => setTeamsUrl(e.target.value)} disabled={pending} />
        {initial.teamsSet && (
          <div className="row gap-2"><button type="button" className="text-2xs muted" style={linkBtn} onClick={() => test("teams")} disabled={pending}>Send test</button><button type="button" className="text-2xs muted" style={linkBtn} onClick={() => clearOne("teams")} disabled={pending}>Remove</button></div>
        )}
      </div>

      <div className="col gap-2">
        <span className="row gap-2 center text-sm"><Switch on={replies} onClick={() => setReplies((v) => !v)} /> Replies</span>
        <span className="row gap-2 center text-sm"><Switch on={status} onClick={() => setStatus((v) => !v)} /> Status changes</span>
        <span className="row gap-2 center text-sm"><Switch on={roadmap} onClick={() => setRoadmap((v) => !v)} /> Roadmap updates</span>
      </div>

      <div className="row gap-2 center">
        <Btn sm variant="primary" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Btn>
        {msg && <span className="text-xs muted">{msg}</span>}
        {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline" };
