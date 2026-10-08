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

type Draft = { title: string; body: string; labels: string; reason: string; confidence: number };

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
  // Closed, it stays mounted and keeps its state, so reopening finds the
  // vendor's edits and any AI draft. A created ticket unmounts it.
  open: boolean;
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
  open,
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
  // The latest AI draft. `held` while it waits for the vendor to apply it.
  const [draft, setDraft] = useState<(Draft & { held: boolean }) | null>(null);
  // The form holds AI-written text, until a tracker switch resets it.
  const [aiInForm, setAiInForm] = useState(false);
  // Any edit since the form was last filled (the item, or an applied draft):
  // a draft arriving then waits instead of replacing the vendor's writing.
  const edited = useRef(false);
  // Bumped per draft request and on a tracker switch; only the latest request
  // may fill the form.
  const draftRun = useRef(0);
  const [pending, startTransition] = useTransition();
  // Whatever opened the dialog (the tile's button), read on first render,
  // before focus moves to the title; it gets focus back on every close.
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null));
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  // Esc, the X, Cancel and the scrim, except while the ticket is being created
  // (closing then would hide how it went).
  function close() {
    if (pending) return;
    setSubmitError(null);
    onClose();
    opener?.focus();
  }

  // On window, like the confirm dialog: a Dropdown stops its own Escape, so Esc
  // there closes just the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function fill(d: Draft) {
    setTitle(d.title);
    setBody(d.body);
    setLabels(d.labels);
    setAiInForm(true);
    edited.current = false;
  }

  function suggest() {
    const run = ++draftRun.current;
    setAiPending(true);
    setSubmitError(null);
    settle(suggestExternalTicket(itemShortId, provider, target || null), DRAFT_TIMEOUT_MS, "draft_timeout").then(r => {
      if (run !== draftRun.current) return;
      setAiPending(false);
      if (!r.ok) {
        setSubmitError(humanError(r.error, provider));
        return;
      }
      const d = { title: r.title, body: r.body, labels: (r.labels ?? []).join(", "), reason: r.reason, confidence: r.confidence };
      const held = edited.current;
      setDraft({ ...d, held });
      if (!held) fill(d);
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
        // A default the tracker no longer lists (a deleted team, a repo the
        // app lost) would sit unseen behind the placeholder: take the first.
        setTarget(r.targets.find(t => t.id === r.defaultTarget)?.id ?? r.targets[0]?.id ?? "");
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

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Create ${providerLabel} ticket`}
      className="sheet-scrim"
      onClick={close}
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
                disabled={aiPending || pending || targetsLoading}
              >
                {aiPending ? "Drafting…" : "Suggest with AI"}
              </Btn>
            )}
            <button
              aria-label="Close"
              onClick={close}
              disabled={pending}
              style={{ background: "none", border: 0, padding: 5, cursor: "pointer", color: "var(--mute)" }}
            >
              <Ic.x style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* A draft arrives after a wait: announce it, without moving focus. */}
        <div aria-live="polite">
          {draft && (
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
                <span className="fw-med">AI draft · {Math.round(draft.confidence * 100)}% confidence</span>
              </span>
              {draft.reason}
              {draft.held && (
                <div className="col gap-2" style={{ marginTop: 8 }}>
                  <span style={{ color: "var(--ink)" }}>
                    You edited the ticket, so the draft didn&apos;t replace your text. Using it replaces the title, description and labels.
                  </span>
                  <div
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--line, var(--hair))",
                      borderRadius: "var(--r-sm)",
                      padding: "8px 10px",
                      maxHeight: 160,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      color: "var(--ink)",
                    }}
                  >
                    <span className="fw-med">{draft.title}</span>
                    {`\n\n${draft.body}`}
                    {draft.labels && `\n\nLabels: ${draft.labels}`}
                  </div>
                  <div className="row gap-2">
                    <Btn sm variant="primary" onClick={() => { fill(draft); setDraft({ ...draft, held: false }); }}>
                      Use the draft
                    </Btn>
                    <Btn sm onClick={() => setDraft(null)}>Keep my text</Btn>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

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
                  // ignore one still on its way. Its text goes too: a Linear or
                  // Jira draft ends with the customer's name and ARR, which must
                  // not ride along into a GitHub issue (repos can be public).
                  if (aiInForm) {
                    setTitle(initialTitle);
                    setBody(initialBody);
                    setLabels("");
                    setAiInForm(false);
                    edited.current = false;
                  }
                  draftRun.current++;
                  setAiPending(false);
                  setDraft(null);
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
              ref={titleRef}
              id="ext-title"
              className="input"
              value={title}
              onChange={e => { edited.current = true; setTitle(e.target.value); }}
              maxLength={240}
            />
          </div>

          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-body">Description</label>
            <textarea
              id="ext-body"
              className="input"
              value={body}
              onChange={e => { edited.current = true; setBody(e.target.value); }}
              rows={8}
            />
            {aiInForm && provider !== "github" && (
              <span className="text-xs muted">The draft ends with the customer&apos;s name and ARR. Remove that if people outside your team can read {providerLabel}.</span>
            )}
          </div>

          <div className="col gap-1">
            <label className="eyebrow" htmlFor="ext-labels">Labels</label>
            <input
              id="ext-labels"
              className="input"
              value={labels}
              onChange={e => { edited.current = true; setLabels(e.target.value); }}
              placeholder="Comma separated"
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
            <Btn onClick={close} disabled={pending}>Cancel</Btn>
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
    case "already_linked":         return "This request is already linked to a ticket.";
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
