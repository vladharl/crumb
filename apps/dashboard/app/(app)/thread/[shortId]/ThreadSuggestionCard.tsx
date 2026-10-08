"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Btn, Card, CardHead, Ic } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { acceptSuggestion, dismissSuggestion } from "../../initiatives/actions";

export type ThreadSuggestion = {
  id: string;
  initiativeId: string;
  initiativeName: string;
  initiativeColor: string | null;
  confidence: number;
  reason: string | null;
};

export function ThreadSuggestionCard({
  suggestion,
  itemShortId,
}: {
  suggestion: ThreadSuggestion;
  itemShortId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const dot = suggestion.initiativeColor ?? "var(--ink)";
  const pct = Math.round(suggestion.confidence * 100);

  function accept() {
    startTransition(async () => {
      const r = await acceptSuggestion(suggestion.id);
      if (r.ok) router.refresh();
      else toast.show({ message: errorMessage(r.error), tone: "error" });
    });
  }

  function dismiss() {
    startTransition(async () => {
      const r = await dismissSuggestion(suggestion.id);
      if (r.ok) router.refresh();
      else toast.show({ message: errorMessage(r.error), tone: "error" });
    });
  }

  // Suppress unused warning when itemShortId isn't read here — kept for
  // future "view in initiative" link if we add it.
  void itemShortId;

  return (
    <Card>
      <CardHead
        title={
          <span className="row gap-2 center">
            <Ic.sparkle style={{ width: 12, height: 12, color: "var(--mute-2)" }} />
            <span>AI suggests</span>
          </span>
        }
      />
      <div className="card-body col gap-3">
        <Link
          href={`/initiatives/${suggestion.initiativeId}`}
          className="row gap-2 center"
          style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}
        >
          <span
            aria-hidden
            style={{ width: 10, height: 10, borderRadius: "50%", background: dot, flexShrink: 0 }}
          />
          <span className="fw-med text-md truncate">{suggestion.initiativeName}</span>
          <span className="text-xs muted mono" style={{ marginLeft: "auto" }}>{pct}%</span>
        </Link>

        {suggestion.reason && (
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
            {suggestion.reason}
          </p>
        )}

        <div className="row gap-2">
          <Btn
            sm
            variant="primary"
            icon={<Ic.check style={{ width: 11, height: 11 }} />}
            onClick={accept}
            disabled={pending}
          >
            {pending ? "Saving…" : "Accept"}
          </Btn>
          <Btn
            sm
            icon={<Ic.x style={{ width: 11, height: 11 }} />}
            onClick={dismiss}
            disabled={pending}
          >
            Dismiss
          </Btn>
        </div>
      </div>
    </Card>
  );
}
