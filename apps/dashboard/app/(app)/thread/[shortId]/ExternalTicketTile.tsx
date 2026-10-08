"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Btn, Card, CardHead, Ic, Pill } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { gmailTime } from "@/lib/timefmt";
import { externalStatusSetup, unlinkExternalTicket } from "./actions";
import { ExternalTicketModal } from "./ExternalTicketModal";

// Single sidebar tile that handles all three states for the engineering
// link, across all three providers. Derives state internally so we don't
// branch on (provider × state) in the parent.
//
// States:
//   (a) no provider connected on this workspace → empty prompt
//   (b) provider connected, no ticket linked → "Create ticket" button
//   (c) ticket linked → ID + URL + last-known status + Unlink, and the truth
//       about sync: when the tracker last reported, or that it can't yet

export type ExternalTicketTileProps = {
  itemShortId: string;
  itemTitle: string;
  itemBody: string;
  aiAvailable: boolean;
  /** Admins get the self-host fix (env var names); everyone else is pointed at an admin. */
  isAdmin?: boolean;
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

// What to do when `provider` can't push status updates here. On Cloud, Jira
// registers a webhook per install, which reconnecting retries; the rest need
// the deployment's own webhook secret, which only an admin can act on (and
// only admins see the setup steps in Settings, Integrations).
function syncFix(provider: "linear" | "jira" | "github", cloud: boolean, isAdmin: boolean): ReactNode {
  const settings = <Link href="/settings/integrations" style={{ color: "var(--ink)" }}>Settings, Integrations</Link>;
  if (provider === "jira" && cloud) return <>An admin can reconnect Jira in {settings} to set them up.</>;
  if (cloud) return <>This deployment hasn&apos;t configured its {PROVIDER_LABEL[provider]} webhook.</>;
  if (!isAdmin) return <>An admin can set this up in Settings, Integrations.</>;
  if (provider === "github") {
    return <>Set <span className="mono">GITHUB_WEBHOOK_SECRET</span> to your GitHub App&apos;s webhook secret, then restart Crumb.</>;
  }
  const secret = provider === "jira" ? "JIRA_WEBHOOK_SECRET" : "LINEAR_WEBHOOK_SECRET";
  return <>They need a webhook in {PROVIDER_LABEL[provider]} signed with <span className="mono">{secret}</span>; {settings} shows how.</>;
}

export function ExternalTicketTile({ itemShortId, itemTitle, itemBody, aiAvailable, isAdmin = false, workspace, item }: ExternalTicketTileProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  // null until first opened. Closed after that, the modal stays mounted (and
  // hidden) so the vendor's edits and a paid-for AI draft survive Esc.
  const [modalOpen, setModalOpen] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  const linearReady = !!workspace.linearInstalledAt;
  const jiraReady = !!workspace.jiraInstalledAt;
  const githubReady = !!workspace.githubInstalledAt;
  const anyConnected = linearReady || jiraReady || githubReady;
  const linked = !!(item.externalProvider && item.externalTicketId);

  // Whether the linked ticket's tracker can push status updates here.
  const linkedProvider = linked ? item.externalProvider : null;
  const [sync, setSync] = useState<{ setUp: boolean; cloud: boolean } | null>(null);
  useEffect(() => {
    setSync(null);
    if (!linkedProvider) return;
    let live = true;
    externalStatusSetup(linkedProvider).then(s => { if (live) setSync(s); }, () => {});
    return () => { live = false; };
  }, [linkedProvider]);

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

    async function onUnlink() {
      if (!(await confirm({
        title: `Unlink ${item.externalTicketId}?`,
        body: `The ticket in ${providerLabel} stays; only the link from this Crumb request is removed.`,
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
          </div>
          {sync && !sync.setUp ? (
            <span className="text-xs muted" style={{ lineHeight: 1.55 }}>
              Status updates aren&apos;t set up for {providerLabel} yet. {syncFix(item.externalProvider!, sync.cloud, isAdmin)}
            </span>
          ) : item.externalSyncedAt ? (
            // Local time: the server's render and the browser's can differ.
            <span className="text-xs muted" suppressHydrationWarning>
              Last update from {providerLabel}: {gmailTime(item.externalSyncedAt)}
            </span>
          ) : sync ? (
            <span className="text-xs muted">No updates from {providerLabel} yet. Its status changes show up here.</span>
          ) : null}
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
            Connect Linear, Jira, or GitHub to push this request out as a ticket and sync engineering status back.
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
              ? "Push this request out as a ticket in the tracker you pick."
              : `Push this request out as a ${providerLabel} ticket.`
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

      {modalOpen !== null && (
        <ExternalTicketModal
          open={modalOpen}
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
