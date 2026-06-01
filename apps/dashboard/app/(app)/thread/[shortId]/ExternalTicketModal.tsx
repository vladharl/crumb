"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown, Ic } from "@crumb/ui";
import { createExternalTicket, listProviderTargets, suggestExternalTicket } from "./actions";

export type ExternalTicketModalProps = {
  itemShortId: string;
  provider: "linear" | "jira" | "github";
  providerLabel: string;
  initialTitle: string;
  initialBody: string;
  aiAvailable: boolean;
  onClose: () => void;
};

export function ExternalTicketModal({
  itemShortId,
  provider,
  providerLabel,
  initialTitle,
  initialBody,
  aiAvailable,
  onClose,
}: ExternalTicketModalProps) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [target, setTarget] = useState<string>("");
  const [targets, setTargets] = useState<Array<{ id: string; label: string }>>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [aiReason, setAiReason] = useState<string | null>(null);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function suggest() {
    setAiPending(true);
    setSubmitError(null);
    suggestExternalTicket(itemShortId, provider).then(r => {
      setAiPending(false);
      if (r.ok) {
        setTitle(r.title);
        setBody(r.body);
        setAiReason(r.reason);
        setAiConfidence(r.confidence);
      } else {
        setSubmitError(humanError(r.error));
      }
    });
  }

  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    listProviderTargets(provider).then(r => {
      if (cancelled) return;
      if (r.ok) {
        setTargets(r.targets);
        setTarget(r.defaultTarget ?? r.targets[0]?.id ?? "");
      } else {
        setTargetsError(humanError(r.error));
      }
      setTargetsLoading(false);
    });
    return () => { cancelled = true; };
  }, [provider]);

  function submit() {
    setSubmitError(null);
    const t = title.trim();
    if (!t) { setSubmitError("Title is required."); return; }
    if (!target) { setSubmitError("Pick a target first."); return; }
    startTransition(async () => {
      const r = await createExternalTicket({
        itemShortId,
        provider,
        title: t,
        body,
        target,
      });
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setSubmitError(humanError(r.error));
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Create ${providerLabel} ticket`}
      style={{
        position: "fixed", inset: 0, background: "rgba(28, 24, 21, 0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 50, padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--paper, var(--surface))",
          border: "1px solid var(--line, var(--hair))",
          borderRadius: "var(--r-md)",
          padding: 20,
          width: "min(640px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "var(--sh-soft)",
        }}
      >
        <div className="row between center" style={{ marginBottom: 12 }}>
          <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>Create {providerLabel} ticket</h3>
          <div className="row gap-2 center">
            {aiAvailable && (
              <Btn
                sm
                icon={<Ic.sparkle style={{ width: 11, height: 11 }} />}
                onClick={suggest}
                disabled={aiPending || pending}
              >
                {aiPending ? "Drafting…" : "Suggest with AI"}
              </Btn>
            )}
            <button
              aria-label="Close"
              onClick={onClose}
              style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--mute)" }}
            >
              <Ic.x style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {aiReason && (
          <div
            className="text-xs"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--line, var(--hair))",
              borderRadius: "var(--r-sm)",
              padding: "8px 10px",
              marginBottom: 12,
              color: "var(--mute)",
              lineHeight: 1.55,
            }}
          >
            <span className="row gap-2 center" style={{ marginBottom: 2 }}>
              <Ic.sparkle style={{ width: 10, height: 10 }} />
              <span className="fw-med">AI draft{aiConfidence !== null ? ` · ${Math.round(aiConfidence * 100)}% confidence` : ""}</span>
            </span>
            {aiReason}
          </div>
        )}

        <div className="col gap-3">
          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-title">Title</label>
            <input
              id="ext-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={240}
              style={inputStyle}
            />
          </div>

          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-body">Description</label>
            <textarea
              id="ext-body"
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={8}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.55 }}
            />
          </div>

          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-target">
              {provider === "linear" ? "Team" : provider === "jira" ? "Project" : "Repository"}
            </label>
            {targetsLoading ? (
              <span className="text-sm muted">Loading targets…</span>
            ) : targetsError ? (
              <span className="text-sm" style={{ color: "var(--err-text)" }}>{targetsError}</span>
            ) : (
              <Dropdown
                ariaLabel={provider === "linear" ? "Team" : provider === "jira" ? "Project" : "Repository"}
                value={target}
                onChange={setTarget}
                disabled={pending}
                searchable={targets.length > 8}
                buttonStyle={{ width: "100%" }}
                options={targets.map(t => ({ value: t.id, label: t.label }))}
              />
            )}
          </div>

          {submitError && (
            <span className="text-xs" style={{ color: "var(--err-text)" }}>{submitError}</span>
          )}

          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            <Btn onClick={onClose} disabled={pending}>Cancel</Btn>
            <Btn
              variant="primary"
              icon={<Ic.send style={{ width: 12, height: 12 }} />}
              onClick={submit}
              disabled={pending || targetsLoading || !!targetsError}
            >
              {pending ? "Creating…" : `Create in ${providerLabel}`}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--line, var(--hair))",
  borderRadius: "var(--r-sm)",
  padding: "8px 10px",
  font: "inherit",
  color: "var(--ink)",
  width: "100%",
};

function humanError(code: string): string {
  switch (code) {
    case "missing_title":          return "Title is required.";
    case "linear_not_connected":   return "Linear isn't connected on this workspace.";
    case "no_team":                return "Pick a team first.";
    case "already_linked":         return "This item is already linked to a ticket.";
    case "provider_create_failed": return "The provider rejected the create. Check your scopes + try again.";
    case "provider_list_failed":   return "Couldn't load targets from the provider.";
    case "not_configured":         return "AI drafting isn't configured on this deployment.";
    case "draft_failed":           return "The model didn't return a usable draft. Try writing manually.";
    case "ai_cap_reached":         return "You've reached this month's AI usage limit. It resets on the 1st.";
    case "linear_revoked":
    case "jira_revoked":
    case "github_revoked":         return "That integration was disconnected. Reconnect it in Settings → Integrations.";
    case "forbidden":              return "Only admins and PMs can create tickets.";
    default:                       return "Something went wrong.";
  }
}
