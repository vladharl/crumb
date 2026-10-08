"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown, Ic } from "@crumb/ui";
import { errorMessage } from "@/lib/action-error";
import { createExternalTicket, listProviderTargets, suggestExternalTicket } from "./actions";

type Provider = "linear" | "jira" | "github";

const PROVIDER_LABEL: Record<Provider, string> = {
  linear: "Linear",
  jira: "Jira",
  github: "GitHub",
};

// How long the modal waits before it stops spinning and says so. A tracker
// lists its teams in a second or two; the model can need a minute or more
// when it's waking up (the server gives it two).
const TARGETS_TIMEOUT_MS = 20_000;
const DRAFT_TIMEOUT_MS = 90_000;
const RETRYABLE_TARGET_ERRORS = new Set(["targets_timeout", "failed", "provider_list_failed"]);

type Failure = { ok: false; error: string };

// The call's own result, or a failure once `ms` pass (timeoutCode) or if it
// throws ("failed"), so nothing in the modal waits forever.
function settle<T>(call: Promise<T>, ms: number, timeoutCode: string): Promise<T | Failure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Failure>(resolve => {
    timer = setTimeout(() => resolve({ ok: false, error: timeoutCode }), ms);
  });
  return Promise.race([call.catch((): Failure => ({ ok: false, error: "failed" })), timeout])
    .finally(() => clearTimeout(timer));
}

export type ExternalTicketModalProps = {
  itemShortId: string;
  // Providers connected on this workspace. When more than one is connected the
  // modal shows a tracker picker; otherwise the single provider is used.
  connectedProviders: Provider[];
  defaultProvider: Provider;
  initialTitle: string;
  initialBody: string;
  aiAvailable: boolean;
  onClose: () => void;
};

export function ExternalTicketModal({
  itemShortId,
  connectedProviders,
  defaultProvider,
  initialTitle,
  initialBody,
  aiAvailable,
  onClose,
}: ExternalTicketModalProps) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>(defaultProvider);
  const providerLabel = PROVIDER_LABEL[provider];
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [labels, setLabels] = useState("");
  const [target, setTarget] = useState<string>("");
  const [targets, setTargets] = useState<Array<{ id: string; label: string }>>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  // An error code, so the retry button can tell a hiccup from a hard stop.
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [targetsAttempt, setTargetsAttempt] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [aiReason, setAiReason] = useState<string | null>(null);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  // Bumped per draft request and on a tracker switch; only the latest request
  // may fill the form.
  const draftRun = useRef(0);
  const [pending, startTransition] = useTransition();

  function suggest() {
    const run = ++draftRun.current;
    setAiPending(true);
    setSubmitError(null);
    settle(suggestExternalTicket(itemShortId, provider, target || null), DRAFT_TIMEOUT_MS, "draft_timeout").then(r => {
      if (run !== draftRun.current) return;
      setAiPending(false);
      if (r.ok) {
        setTitle(r.title);
        setBody(r.body);
        setLabels((r.labels ?? []).join(", "));
        setAiReason(r.reason);
        setAiConfidence(r.confidence);
      } else {
        setSubmitError(humanError(r.error, provider));
      }
    });
  }

  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    setTargetsError(null);
    setTarget("");
    settle(listProviderTargets(provider), TARGETS_TIMEOUT_MS, "targets_timeout").then(r => {
      if (cancelled) return;
      if (r.ok) {
        setTargets(r.targets);
        setTarget(r.defaultTarget ?? r.targets[0]?.id ?? "");
      } else {
        setTargetsError(r.error);
      }
      setTargetsLoading(false);
    });
    return () => { cancelled = true; };
  }, [provider, targetsAttempt]);

  function submit() {
    setSubmitError(null);
    const t = title.trim();
    if (!t) { setSubmitError("Title is required."); return; }
    if (!target) { setSubmitError("Pick a target first."); return; }
    startTransition(async () => {
      // No client timeout here: a create that lands late still made a ticket,
      // and a retry would make a second one.
      const r = await createExternalTicket({
        itemShortId,
        provider,
        title: t,
        body,
        target,
        labels: labels.split(",").map(l => l.trim()).filter(Boolean),
      }).catch((): Failure => ({ ok: false, error: "failed" }));
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setSubmitError(humanError(r.error, provider));
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Create ${providerLabel} ticket`}
      className="sheet-scrim"
      onClick={onClose}
    >
      <div
        className="sheet wide"
        onClick={e => e.stopPropagation()}
        style={{ padding: 20 }}
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
          {connectedProviders.length > 1 && (
            <div className="col gap-1">
              <label className="eyebrow" htmlFor="ext-provider">Tracker</label>
              <Dropdown
                ariaLabel="Tracker"
                value={provider}
                onChange={v => {
                  setProvider(v as Provider);
                  // A draft is written in the prior tracker's voice; drop it so
                  // it isn't mistaken for a suggestion for the new one, and
                  // ignore one still on its way.
                  draftRun.current++;
                  setAiPending(false);
                  setAiReason(null);
                  setAiConfidence(null);
                }}
                disabled={pending}
                buttonStyle={{ width: "100%" }}
                options={connectedProviders.map(p => ({ value: p, label: PROVIDER_LABEL[p] }))}
              />
            </div>
          )}

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
            {aiReason && provider !== "github" && (
              <span className="text-xs muted">The draft ends with the customer&apos;s name and ARR. Remove that if people outside your team can read {providerLabel}.</span>
            )}
          </div>

          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-labels">Labels</label>
            <input
              id="ext-labels"
              value={labels}
              onChange={e => setLabels(e.target.value)}
              placeholder="Comma separated"
              style={inputStyle}
            />
            {provider !== "github" && labels.trim() && (
              <span className="text-xs muted">{providerLabel} gets these as the last line of the description.</span>
            )}
          </div>

          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-target">
              {provider === "linear" ? "Team" : provider === "jira" ? "Project" : "Repository"}
            </label>
            {targetsLoading ? (
              <span className="text-sm muted">Loading targets…</span>
            ) : targetsError ? (
              <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                <span className="text-sm" style={{ color: "var(--err-text)" }}>{humanError(targetsError, provider)}</span>
                {RETRYABLE_TARGET_ERRORS.has(targetsError) && (
                  <Btn sm onClick={() => setTargetsAttempt(n => n + 1)}>Try again</Btn>
                )}
              </div>
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
            <span role="alert" className="text-xs" style={{ color: "var(--err-text)" }}>{submitError}</span>
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

function humanError(code: string, provider: Provider): string {
  const name = PROVIDER_LABEL[provider];
  switch (code) {
    case "missing_title":          return "Title is required.";
    case "linear_not_connected":   return "Linear isn't connected on this workspace.";
    case "jira_not_connected":     return "Jira isn't connected on this workspace.";
    case "github_not_connected":   return "GitHub isn't connected on this workspace.";
    case "no_team":                return "Pick a team first.";
    case "no_project":             return "Pick a project first.";
    case "no_repo":                return "Pick a repository first.";
    case "already_linked":         return "This item is already linked to a ticket.";
    case "provider_create_failed": return `${name} didn't create the ticket. Check the integration's permissions and try again.`;
    case "provider_list_failed":   return `Couldn't load targets from ${name}.`;
    case "targets_timeout":        return `${name} took too long to answer.`;
    case "plan_required":          return "Your plan doesn't include tracker tickets. An admin can upgrade in Settings under Billing.";
    case "not_configured":         return "AI drafting isn't configured on this deployment.";
    case "not_entitled":           return "Your plan doesn't include AI drafts.";
    case "draft_failed":           return "The AI didn't return a usable draft. Try again, or write the ticket yourself.";
    case "draft_timeout":          return "The AI took too long to answer. Try again, or write the ticket yourself.";
    case "ai_cap_reached":         return "You've reached this month's AI usage limit. It resets on the 1st.";
    case "linear_revoked":
    case "jira_revoked":
    case "github_revoked":         return "That integration was disconnected. Reconnect it in Settings → Integrations.";
    case "forbidden":              return "Only admins and PMs can create tickets.";
    default:                       return errorMessage(code);
  }
}
