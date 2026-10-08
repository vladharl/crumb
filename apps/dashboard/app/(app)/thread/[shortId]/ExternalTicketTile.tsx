"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Btn, Card, CardHead, Ic, Pill } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { unlinkExternalTicket } from "./actions";
import { ExternalTicketModal } from "./ExternalTicketModal";

// Single sidebar tile that handles all four states for the engineering
// link, across all three providers. Derives state internally so we don't
// branch on (provider × state) in the parent.
//
// States:
//   (a) no provider connected on this workspace → empty prompt
//   (b) provider connected, no ticket linked → "Create ticket" button
//   (c) ticket linked → ID + URL + last-known status + Unlink
//   (d) linked + sync stale (>24h) → (c) with a "syncing…" badge

export type ExternalTicketTileProps = {
  itemShortId: string;
  itemTitle: string;
  itemBody: string;
  aiAvailable: boolean;
  workspace: {
    linearInstalledAt: string | null;
    jiraInstalledAt: string | null;
    githubInstalledAt: string | null;
  };
  item: {
    externalProvider: "linear" | "jira" | "github" | null;
    externalTicketId: string | null;
    externalTicketUrl: string | null;
    externalStatus: string | null;
    externalSyncedAt: string | null;
  };
};

const PROVIDER_LABEL: Record<"linear" | "jira" | "github", string> = {
  linear: "Linear",
  jira: "Jira",
  github: "GitHub",
};

const STALE_MS = 24 * 60 * 60 * 1000;

export function ExternalTicketTile({ itemShortId, itemTitle, itemBody, aiAvailable, workspace, item }: ExternalTicketTileProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const linearReady = !!workspace.linearInstalledAt;
  const jiraReady = !!workspace.jiraInstalledAt;
  const githubReady = !!workspace.githubInstalledAt;
  const anyConnected = linearReady || jiraReady || githubReady;
  const linked = !!(item.externalProvider && item.externalTicketId);

  // Multiple providers can be connected at once. The modal lets the vendor
  // pick among the connected ones; this fixed priority (Linear > Jira > GitHub)
  // is just the pre-selected default.
  const connectedProviders = ([
    linearReady ? "linear" : null,
    jiraReady ? "jira" : null,
    githubReady ? "github" : null,
  ] as const).filter((p): p is "linear" | "jira" | "github" => p !== null);
  const defaultProvider: "linear" | "jira" | "github" =
    linearReady ? "linear" : jiraReady ? "jira" : "github";

  // ── State (c): ticket linked ──────────────────────────────
  if (linked) {
    const providerLabel = PROVIDER_LABEL[item.externalProvider!];
    const syncedAt = item.externalSyncedAt ? new Date(item.externalSyncedAt) : null;
    const stale = syncedAt ? (Date.now() - syncedAt.getTime() > STALE_MS) : false;

    async function onUnlink() {
      if (!(await confirm({
        title: `Unlink ${item.externalTicketId}?`,
        body: `The ticket in ${providerLabel} stays; only the link from this Crumb item is removed.`,
        confirmLabel: "Unlink",
        destructive: true,
      }))) return;
      startTransition(async () => {
        const r = await unlinkExternalTicket(itemShortId);
        if (r.ok) router.refresh();
        else toast.show({ message: errorMessage(r.error), tone: "error" });
      });
    }

    return (
      <Card>
        <CardHead title="Engineering" after={item.externalStatus ? <Pill solid>{item.externalStatus}</Pill> : null} />
        <div className="card-body col gap-2">
          <div className="row gap-2 center">
            {item.externalTicketUrl ? (
              <a
                href={item.externalTicketUrl}
                target="_blank"
                rel="noreferrer"
                className="mono text-sm"
                style={{ color: "var(--ink)" }}
              >
                {item.externalTicketId}
              </a>
            ) : (
              <span className="mono text-sm">{item.externalTicketId}</span>
            )}
            <Pill>{providerLabel}</Pill>
            {stale && <Pill ring>syncing…</Pill>}
          </div>
          <span className="text-xs muted">
            Engineering status syncs from {providerLabel}, not authoritative.
          </span>
          <div className="row gap-2">
            <Btn sm onClick={onUnlink} disabled={pending}>
              {pending ? "Unlinking…" : "Unlink"}
            </Btn>
          </div>
        </div>
      </Card>
    );
  }

  // ── State (a): no provider connected ───────────────────────
  if (!anyConnected) {
    return (
      <Card>
        <CardHead title="Engineering" />
        <div className="card-body col gap-2">
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Connect Linear, Jira, or GitHub to push this item out as a ticket and sync engineering status back.
          </p>
          <Link href="/settings/integrations" className="link-back" style={{ alignSelf: "flex-start" }}>
            Settings → Integrations →
          </Link>
        </div>
      </Card>
    );
  }

  // ── State (b): provider connected, no ticket linked ────────
  // Pre-select the highest-priority connected provider; if more than one is
  // connected the modal shows a tracker picker, and its target dropdown lets
  // the vendor pick within the chosen provider.
  const createReady = connectedProviders.length > 0;
  const multiProvider = connectedProviders.length > 1;
  const providerLabel = PROVIDER_LABEL[defaultProvider];

  return (
    <Card>
      <CardHead title="Engineering" />
      <div className="card-body col gap-2">
        <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
          {createReady
            ? multiProvider
              ? "Push this item out as a ticket and pick the tracker. Engineering status will sync back."
              : `Push this item out as a ${providerLabel} ticket. Engineering status will sync back.`
            : "Connect a provider in Settings to create a ticket from here."}
        </p>
        <div className="row gap-2">
          <Btn
            sm
            variant="primary"
            icon={<Ic.send style={{ width: 11, height: 11 }} />}
            disabled={!createReady || pending}
            onClick={() => setModalOpen(true)}
          >
            {multiProvider ? "Create ticket" : `Create ${providerLabel} ticket`}
          </Btn>
        </div>
      </div>

      {modalOpen && (
        <ExternalTicketModal
          itemShortId={itemShortId}
          connectedProviders={connectedProviders}
          defaultProvider={defaultProvider}
          initialTitle={itemTitle}
          initialBody={itemBody}
          aiAvailable={aiAvailable}
          onClose={() => setModalOpen(false)}
        />
      )}
    </Card>
  );
}
