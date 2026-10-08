import type { ReactNode } from "react";
import { headers } from "next/headers";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { SelfHostSetup } from "./SelfHostSetup";
import type { Provider } from "@/lib/integrations/state";
import { originFromHeaders } from "@/lib/origin";
import { formatDate } from "@/lib/timefmt";
import { hasFeature, integrationsAllowed, workspacePlan } from "@/lib/entitlements";
import { slackConfigured } from "@/lib/slack/install";
import { linearConfigured } from "@/lib/integrations/linear";
import { jiraConfigured, statusSyncReady as jiraStatusSyncReady } from "@/lib/integrations/jira";
import { githubConfigured } from "@/lib/integrations/github";
import { crmConfigured, getCrmAdapter } from "@/lib/integrations/crm";
import { ConnectSlackButton, DisconnectSlackButton } from "./SlackActions";
import { ConnectLinearButton, DisconnectLinearButton } from "./LinearActions";
import { TrackerDefaultPicker } from "./TrackerDefaultPicker";
import { ConnectJiraButton, DisconnectJiraButton, JiraSitePicker } from "./JiraActions";
import { ConnectGithubButton, DisconnectGithubButton } from "./GithubActions";
import {
  ConnectHubspotButton, DisconnectHubspotButton,
  ConnectSalesforceButton, DisconnectSalesforceButton,
  SyncCrmButton, CrmArrFieldPicker,
} from "./CrmActions";
import { ConnectTeamsForm, TeamsConnectedActions } from "./TeamsActions";
import { SessionRecordToggle } from "./SessionRecordToggle";
import { retentionDaysForPlan } from "@/lib/replay/sweep";
import { FeedbackConnectors } from "./FeedbackConnectors";
import { listConnections } from "@/lib/integrations/feedback/connections";
import { disconnectNotice } from "@/lib/integrations/revoke";
import { UpgradeNotice } from "@/components/UpgradeNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations · Settings" };

// What a callback's ?{provider}={code} means, in words. `operator` is the next
// step for whoever runs the server, added on self-host only: Cloud admins
// can't change Crumb's own app credentials.
type BannerCopy = { kind: "ok" | "err"; text: string; operator?: string };

// Every callback's session check (lib/integrations/callback.ts), and the
// failures each OAuth provider shares.
const SESSION_BANNER: Record<string, BannerCopy> = {
  error_wrong_workspace: { kind: "err", text: "You're signed in to a different workspace than the one that started this connection. Switch workspaces and connect again." },
  error_forbidden:       { kind: "err", text: "Only workspace admins can finish connecting an integration." },
  error_bad_state:       { kind: "err", text: "This connection couldn't be verified, or it took too long. Start it again from this page." },
  error_workspace_gone:  { kind: "err", text: "This workspace couldn't be found while finishing the connection." },
};

const SLACK_BANNER: Record<string, BannerCopy> = {
  ...SESSION_BANNER,
  connected:                  { kind: "ok",  text: "Slack connected. Teammates can now choose Slack for their alerts in their notification settings." },
  error_missing_params:       { kind: "err", text: "Slack didn't send back everything Crumb needs. Please try again." },
  error_exchange_failed:      { kind: "err", text: "Slack didn't accept the connection. Please try again.", operator: "If it keeps failing, check the Slack app's client secret and scopes." },
  error_team_already_connected: { kind: "err", text: "That Slack workspace is already connected to another Crumb workspace. Disconnect it there first." },
};

const LINEAR_BANNER: Record<string, BannerCopy> = {
  ...SESSION_BANNER,
  connected:             { kind: "ok",  text: "Linear connected. From any thread, click Create ticket in the Engineering panel to push the request out." },
  error_missing_params:  { kind: "err", text: "Linear didn't send back everything Crumb needs. Please try again." },
  error_exchange_failed: { kind: "err", text: "Linear didn't accept the connection. Please try again.", operator: "If it keeps failing, check the Linear app's client secret and redirect URL." },
};

const JIRA_BANNER: Record<string, BannerCopy> = {
  ...SESSION_BANNER,
  connected:               { kind: "ok",  text: "Jira connected. From any thread, click Create ticket in the Engineering panel to push the request out." },
  connected_no_sync:       { kind: "ok",  text: "Jira connected, but status sync couldn't be set up. Reconnect to try again. Creating tickets works." },
  pick_site:               { kind: "ok",  text: "Jira connected. Your Atlassian login reaches more than one Jira site, so choose the one this workspace uses below." },
  error_missing_params:    { kind: "err", text: "Jira didn't send back everything Crumb needs. Please try again." },
  error_exchange_failed:   { kind: "err", text: "Atlassian didn't accept the connection. Please try again.", operator: "If it keeps failing, check the Atlassian app's client secret and callback URL." },
  error_resources_failed:  { kind: "err", text: "Couldn't find your Jira site after connecting. Check that your Atlassian login can reach at least one Jira site." },
  error_no_resources:      { kind: "err", text: "Your Atlassian login can't reach any Jira site. Connect with an account that can." },
};

const GITHUB_BANNER: Record<string, BannerCopy> = {
  ...SESSION_BANNER,
  connected:           { kind: "ok",  text: "GitHub connected. Create issues from any thread, and choose the repository new issues start in below." },
  error_missing_params:{ kind: "err", text: "GitHub didn't send back everything Crumb needs. Please try again." },
  error_meta_failed:   { kind: "err", text: "Crumb couldn't read that GitHub installation. Please try again.", operator: "If it keeps failing, check the GitHub App's private key." },
  error_install_taken: { kind: "err", text: "That GitHub installation is already connected to another Crumb workspace." },
  error_not_owner:     { kind: "err", text: "GitHub couldn't confirm you can access that installation. Start again from this page, and if the app was installed before, reinstall it.", operator: "This check needs the GitHub App's client ID and secret, with user authorization during installation turned on." },
  // GitHub's setup_action=request: a member asked an organization owner to install the app.
  error_request:       { kind: "ok",  text: "GitHub sent your install request to an organization owner. Once they approve it, connect again from this page." },
};

const CRM_BANNER: Record<string, BannerCopy> = {
  ...SESSION_BANNER,
  connected:             { kind: "ok",  text: "CRM connected. Accounts are syncing to the Accounts page. ARR syncs from the field chosen below, and manually set ARR is never overwritten." },
  error_missing_params:  { kind: "err", text: "The CRM didn't send back everything Crumb needs. Please try again." },
  error_exchange_failed: { kind: "err", text: "The CRM didn't accept the connection. Please try again.", operator: "If it keeps failing, check the CRM app's client secret and redirect URL." },
};

// The banner for a callback result, or null. A code with no copy (whatever a
// provider put in its own `error`) never reaches the page as-is.
function bannerFor(map: Record<string, BannerCopy>, code: string | undefined, name: string, cloud: boolean): BannerCopy | null {
  if (!code) return null;
  const b: BannerCopy = map[code] ?? {
    kind: "err",
    text: code === "error_access_denied"
      ? `Connecting ${name} was cancelled, so nothing changed.`
      : `${name} didn't finish connecting. Please try again.`,
  };
  return { kind: b.kind, text: !cloud && b.operator ? `${b.text} ${b.operator}` : b.text };
}

// A provider this server has no app credentials for: muted, so it never reads
// as Connected. The card body says what that means for whoever's looking.
// Neither does an install the plan no longer covers (a Cloud downgrade keeps
// it, so an upgrade picks up where it left off): Paused, with a PausedNote.
function connectionPill(installed: boolean, canInstall: boolean, paused: boolean) {
  if (installed) return paused ? <Pill variant="muted">Paused</Pill> : <Pill ring ringFill>Connected</Pill>;
  return canInstall ? <Pill>Not connected</Pill> : <Pill variant="muted">Not set up</Pill>;
}

function PausedNote({ children }: { children: ReactNode }) {
  return <p className="text-xs muted note">Paused: your plan no longer includes integrations, so {children}.</p>;
}

// Why a card that isn't connected has no Connect button, in plain words. Not
// set up: the server has no app for the provider, and only admins on
// self-host (the people who run the server) see how to add one, env var names
// and all. Set up: the viewer isn't an admin.
function ConnectNote({ name, provider, canInstall, isAdmin, cloud, origin }: {
  name: string;
  provider: Provider;
  canInstall: boolean;
  isAdmin: boolean;
  cloud: boolean;
  origin: string | null;
}) {
  const note = { margin: 0, lineHeight: 1.55, maxWidth: "62ch" } as const;
  if (canInstall) return isAdmin ? null : <p className="text-xs muted" style={note}>Only workspace admins can connect {name}.</p>;
  return (
    <>
      <p className="text-xs muted" style={note}>
        {cloud
          ? "Not set up on this server yet."
          : isAdmin
            ? `Not set up on this server yet. Create a ${name} app with the values below, give Crumb its keys, and restart.`
            : "Not set up on this server yet. Whoever runs Crumb for your team can turn it on."}
      </p>
      {!cloud && isAdmin && <SelfHostSetup provider={provider} origin={origin} />}
    </>
  );
}

function Banner({ kind, text }: { kind: "ok" | "err"; text: string }) {
  return (
    <div className="text-sm" style={{
      background: kind === "ok" ? "var(--surface-2)" : "var(--err-bg)",
      border: `1px solid ${kind === "ok" ? "var(--hair)" : "var(--err-border)"}`,
      color: kind === "ok" ? "var(--ink)" : "var(--err-text)",
      borderRadius: "var(--r-sm)",
      padding: "10px 12px",
      lineHeight: 1.55,
    }}>
      {text}
    </div>
  );
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: { slack?: string; linear?: string; jira?: string; github?: string; hubspot?: string; salesforce?: string };
}) {
  const { workspace: ws, user } = await getActiveSession();
  const cloud = isCloud();
  const isAdmin = user.role === "admin";
  // Origin for the self-host setup helper's callback/webhook URLs.
  const origin = originFromHeaders(headers());
  // Per-workspace entitlements. Self-host: integrations stay creds-gated
  // (integrationsAllowed → true); AI/session-record off. Cloud: plan-gated.
  const integrationsEntitled = integrationsAllowed(ws);
  const sessionRecordEntitled = hasFeature(ws, "session_record");
  const replayRetentionDays = retentionDaysForPlan(workspacePlan(ws));
  // On Cloud, integrations need the plan; surface that distinctly from the
  // self-host "set ENV creds" message.
  const integrationsPlanLocked = cloud && !integrationsEntitled;

  const slackInstalled = !!ws.slackBotToken;
  const slackCanInstall = slackConfigured();
  const slackBanner = bannerFor(SLACK_BANNER, searchParams.slack, "Slack", cloud);

  const linearInstalled = !!ws.linearAccessToken;
  const linearCanInstall = linearConfigured();
  const linearBanner = bannerFor(LINEAR_BANNER, searchParams.linear, "Linear", cloud);

  const jiraInstalled = !!ws.jiraAccessToken;
  const jiraCanInstall = jiraConfigured();
  const jiraStatusSync = jiraStatusSyncReady(ws);
  const jiraBanner = bannerFor(JIRA_BANNER, searchParams.jira, "Jira", cloud);

  const githubInstalled = !!ws.githubAppInstallId;
  const githubCanInstall = githubConfigured();
  const githubBanner = bannerFor(GITHUB_BANNER, searchParams.github, "GitHub", cloud);

  // CRM: account count + last sync per provider, for the connected-state copy.
  const crmStatRows = await db
    .select({
      provider: accounts.externalCrmProvider,
      count: sql<number>`COUNT(*)::int`,
      lastSync: sql<Date | null>`MAX(${accounts.crmSyncedAt})`,
    })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, ws.id), isNotNull(accounts.externalCrmProvider)))
    .groupBy(accounts.externalCrmProvider);
  const crmStats = Object.fromEntries(crmStatRows.map(r => [r.provider, { count: r.count, lastSync: r.lastSync }]));
  const fmtSync = (d: Date | null | undefined) => (d ? formatDate(d) : null);

  const hubspotInstalled = !!ws.hubspotAccessToken;
  const hubspotCanInstall = crmConfigured("hubspot");
  const hubspotArrField = getCrmAdapter("hubspot").arrField(ws);
  const hubspotBanner = bannerFor(CRM_BANNER, searchParams.hubspot, "HubSpot", cloud);

  const salesforceInstalled = !!ws.salesforceAccessToken;
  const salesforceCanInstall = crmConfigured("salesforce");
  const salesforceArrField = getCrmAdapter("salesforce").arrField(ws);
  const salesforceBanner = bannerFor(CRM_BANNER, searchParams.salesforce, "Salesforce", cloud);

  // Inbound feedback connectors (Autopilot). Creds-gated like the rest; the AI
  // new-and-relevant filter additionally needs the "ai" feature (Cloud). On a
  // plan without integrations, existing connections still show, paused, so
  // they can be disconnected.
  const feedbackConnections = await listConnections(ws.id);
  const aiEnabled = hasFeature(ws, "ai");

  // An integration Crumb disconnected on its own (its access was revoked):
  // a Reconnect banner on its card until it's connected again.
  const notice = (provider: Parameters<typeof disconnectNotice>[1]) => {
    const n = disconnectNotice(ws, provider);
    return n && <Banner kind="err" text={n.text} />;
  };

  const teamsConnected = !!ws.teamsWebhookUrl;

  return (
    <>
      {integrationsPlanLocked && <UpgradeNotice feature="integrations" isAdmin={isAdmin} />}

      {/* ─── Linear ─────────────────────────────────────────── */}
      <Card>
        <CardHead
          title="Linear"
          after={
            connectionPill(linearInstalled, linearCanInstall, !integrationsEntitled)
          }
        />
        <div className="card-body col gap-3">
          {linearBanner && <Banner kind={linearBanner.kind} text={linearBanner.text} />}

          {linearInstalled ? (
            <>
              <p className="text-sm note">
                Connected to <strong style={{ fontWeight: 500 }}>{ws.linearTeamName ?? "Linear"}</strong>
                {ws.linearInstalledAt && (
                  <> since {formatDate(ws.linearInstalledAt)}</>
                )}.
              </p>
              {!integrationsEntitled && <PausedNote>threads can&apos;t create Linear issues</PausedNote>}
              <p className="text-xs muted note">
                The status customers see stays the one you set in Crumb. The issue&apos;s status in Linear shows beside it in the thread, for reference.
              </p>
              {/* Cloud's Linear app carries the webhook; self-host adds its own,
                  which only an admin (who runs the server) can. */}
              {!cloud && isAdmin && (
                <details style={{ borderTop: "var(--border)", paddingTop: 10 }}>
                  <summary className="text-xs" style={{ cursor: "pointer", color: "var(--ink)" }}>
                    Status sync needs a webhook in Linear
                  </summary>
                  <div className="col gap-2" style={{ marginTop: 10 }}>
                    <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                      Linear can&apos;t register webhooks automatically. In Linear, open Settings → API → Webhooks, add the URL below, subscribe to Issue events, and sign it with your <span className="mono">LINEAR_WEBHOOK_SECRET</span>. Until then, tickets are created but engineering status won&apos;t sync back.
                    </p>
                    <div className="col gap-1">
                      <span className="eyebrow">Webhook URL</span>
                      <div className="code" style={{ wordBreak: "break-all" }}>{`${origin ?? "https://your-dashboard.example.com"}/api/integrations/linear/webhook`}</div>
                    </div>
                  </div>
                </details>
              )}
              {isAdmin
                ? (
                  <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                    {integrationsEntitled && <TrackerDefaultPicker provider="linear" current={ws.linearTeamId} />}
                    <DisconnectLinearButton teamName={ws.linearTeamName} />
                  </div>
                )
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              {notice("linear")}
              <p className="text-sm muted note">
                Create Linear issues from feedback and see their status back in Crumb. On Cloud plans with AI, Crumb drafts the title and description in your team&apos;s voice.
              </p>
              <ConnectNote name="Linear" provider="linear" canInstall={linearCanInstall} isAdmin={isAdmin} cloud={cloud} origin={origin} />
              <div className="row gap-2">
                {isAdmin && linearCanInstall && integrationsEntitled
                  ? <ConnectLinearButton />
                  : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── Jira ───────────────────────────────────────────── */}
      <Card>
        <CardHead
          title="Jira"
          after={
            connectionPill(jiraInstalled, jiraCanInstall, !integrationsEntitled)
          }
        />
        <div className="card-body col gap-3">
          {jiraBanner && <Banner kind={jiraBanner.kind} text={jiraBanner.text} />}

          {jiraInstalled && !ws.jiraCloudId ? (
            // No site yet: the login reaches several, or lost the one it had.
            <>
              <p className="text-sm note">
                Choose the Jira site this workspace creates tickets in. Until then, tickets can&apos;t go to Jira.
              </p>
              {!integrationsEntitled && <PausedNote>a site can&apos;t be chosen and threads can&apos;t create Jira issues</PausedNote>}
              {isAdmin
                ? (
                  <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                    {integrationsEntitled && <JiraSitePicker />}
                    <DisconnectJiraButton siteUrl={null} />
                  </div>
                )
                : <p className="text-xs muted" style={{ margin: 0 }}>A workspace admin needs to choose the site.</p>}
            </>
          ) : jiraInstalled ? (
            <>
              <p className="text-sm note">
                Connected to <strong style={{ fontWeight: 500 }}>{ws.jiraSiteUrl ? ws.jiraSiteUrl.replace(/^https?:\/\//, "") : "Jira"}</strong>
                {ws.jiraInstalledAt && (
                  <> since {formatDate(ws.jiraInstalledAt)}</>
                )}
                {ws.jiraDefaultProjectKey && (
                  <> · default project <span className="mono">{ws.jiraDefaultProjectKey}</span></>
                )}.
              </p>
              {!integrationsEntitled && <PausedNote>threads can&apos;t create Jira issues</PausedNote>}
              <p className="text-xs muted note">
                The status customers see stays the one you set in Crumb. The issue&apos;s status in Jira shows beside it in the thread, for reference.
              </p>
              {/* Its remedy (reconnect) and its "still works" need the plan. */}
              {cloud && !jiraStatusSync && integrationsEntitled && (
                <p className="text-xs note" style={{ color: "var(--err-text)" }}>
                  Status sync isn&apos;t set up, so linked tickets won&apos;t update here. Reconnect Jira to try again; creating tickets still works.
                </p>
              )}
              {!cloud && isAdmin && (
                <details style={{ borderTop: "var(--border)", paddingTop: 10 }}>
                  <summary className="text-xs" style={{ cursor: "pointer", color: "var(--ink)" }}>
                    Status sync needs a webhook in Jira
                  </summary>
                  <div className="col gap-2" style={{ marginTop: 10 }}>
                    <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                      In Jira, open Settings → System → WebHooks, create a webhook with the URL below for issue updated events, and set its secret to your <span className="mono">JIRA_WEBHOOK_SECRET</span>. Until then, tickets are created but engineering status won&apos;t sync back.
                    </p>
                    <div className="col gap-1">
                      <span className="eyebrow">Webhook URL</span>
                      <div className="code" style={{ wordBreak: "break-all" }}>{`${origin ?? "https://your-dashboard.example.com"}/api/integrations/jira/webhook`}</div>
                    </div>
                  </div>
                </details>
              )}
              {isAdmin
                ? (
                  <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                    {integrationsEntitled && <TrackerDefaultPicker provider="jira" current={ws.jiraDefaultProjectKey} />}
                    {cloud && !jiraStatusSync && jiraCanInstall && integrationsEntitled && <ConnectJiraButton reconnect />}
                    <DisconnectJiraButton siteUrl={ws.jiraSiteUrl} />
                  </div>
                )
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              {notice("jira")}
              <p className="text-sm muted note">
                Create Jira issues from feedback and see their status back in Crumb. Works with Jira Cloud, not Jira Server or Data Center.
              </p>
              <ConnectNote name="Jira" provider="jira" canInstall={jiraCanInstall} isAdmin={isAdmin} cloud={cloud} origin={origin} />
              <div className="row gap-2">
                {isAdmin && jiraCanInstall && integrationsEntitled
                  ? <ConnectJiraButton />
                  : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── GitHub ─────────────────────────────────────────── */}
      <Card>
        <CardHead
          title="GitHub"
          after={
            connectionPill(githubInstalled, githubCanInstall, !integrationsEntitled)
          }
        />
        <div className="card-body col gap-3">
          {githubBanner && <Banner kind={githubBanner.kind} text={githubBanner.text} />}

          {githubInstalled ? (
            <>
              <p className="text-sm note">
                Installed on <strong style={{ fontWeight: 500 }}>{ws.githubAppInstallAccount ?? "GitHub"}</strong>
                {ws.githubInstalledAt && (
                  <> since {formatDate(ws.githubInstalledAt)}</>
                )}
                {ws.githubDefaultRepo && (
                  <> · default repo <span className="mono">{ws.githubDefaultRepo}</span></>
                )}.
              </p>
              {!integrationsEntitled && <PausedNote>threads can&apos;t create GitHub issues</PausedNote>}
              <p className="text-xs muted note">
                {ws.githubDefaultRepo
                  ? "New issues start in this repo. On Cloud plans with AI, ticket drafts for Linear and Jira and Slack request sizing also read its README and file layout."
                  : "Choose a default repository. New issues start there, and AI drafts and Slack sizing (Cloud) read its README and file layout."}
              </p>
              {isAdmin
                ? (
                  <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                    {integrationsEntitled && <TrackerDefaultPicker provider="github" current={ws.githubDefaultRepo} />}
                    <DisconnectGithubButton account={ws.githubAppInstallAccount} />
                  </div>
                )
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              {notice("github")}
              <p className="text-sm muted note">
                Create GitHub issues from feedback and see their status back in Crumb. On Cloud plans with AI, ticket drafts for any tracker and Slack request sizing also read your repo&apos;s README and file layout.
              </p>
              <ConnectNote name="GitHub" provider="github" canInstall={githubCanInstall} isAdmin={isAdmin} cloud={cloud} origin={origin} />
              <div className="row gap-2">
                {isAdmin && githubCanInstall && integrationsEntitled
                  ? <ConnectGithubButton />
                  : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── HubSpot (CRM: accounts + ARR) ──────────────────── */}
      <Card>
        <CardHead
          title="HubSpot"
          after={
            connectionPill(hubspotInstalled, hubspotCanInstall, !integrationsEntitled)
          }
        />
        <div className="card-body col gap-3">
          {hubspotBanner && <Banner kind={hubspotBanner.kind} text={hubspotBanner.text} />}

          {hubspotInstalled ? (
            <>
              <p className="text-sm note">
                Connected{ws.hubspotPortalId ? <> to portal <span className="mono">{ws.hubspotPortalId}</span></> : ""}
                {ws.hubspotInstalledAt && (
                  <> since {formatDate(ws.hubspotInstalledAt)}</>
                )}.{" "}
                {crmStats["hubspot"] ? <>{crmStats["hubspot"].count} accounts synced{fmtSync(crmStats["hubspot"].lastSync) ? <> · last {fmtSync(crmStats["hubspot"].lastSync)}</> : null}.</> : "Run a sync to pull accounts."}
              </p>
              <p className="text-xs muted note">
                {hubspotArrField
                  ? <>Companies sync into Accounts, with ARR from the <span className="mono">{hubspotArrField}</span> property. Manually set ARR is never overwritten.</>
                  : <>Companies sync into Accounts by name. To sync ARR too, an admin picks the property that holds what each company pays you (Annual revenue is the company&apos;s own revenue, so it&apos;s never assumed).</>}
              </p>
              <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
                <SyncCrmButton provider="hubspot" />
                {isAdmin && integrationsEntitled && <CrmArrFieldPicker provider="hubspot" current={hubspotArrField} />}
                {isAdmin
                  ? <DisconnectHubspotButton />
                  : <span className="text-xs muted">Only workspace admins can disconnect.</span>}
              </div>
            </>
          ) : (
            <>
              {notice("hubspot")}
              <p className="text-sm muted note">
                Sync your HubSpot companies and their ARR into Accounts, so ranking by revenue uses live figures instead of hand-entered ones. Crumb only reads from HubSpot.
              </p>
              <ConnectNote name="HubSpot" provider="hubspot" canInstall={hubspotCanInstall} isAdmin={isAdmin} cloud={cloud} origin={origin} />
              <div className="row gap-2">
                {isAdmin && hubspotCanInstall && integrationsEntitled ? <ConnectHubspotButton /> : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── Salesforce (CRM: accounts + ARR) ───────────────── */}
      <Card>
        <CardHead
          title="Salesforce"
          after={
            connectionPill(salesforceInstalled, salesforceCanInstall, !integrationsEntitled)
          }
        />
        <div className="card-body col gap-3">
          {salesforceBanner && <Banner kind={salesforceBanner.kind} text={salesforceBanner.text} />}

          {salesforceInstalled ? (
            <>
              <p className="text-sm note">
                Connected{ws.salesforceInstanceUrl ? <> to <span className="mono">{ws.salesforceInstanceUrl.replace(/^https?:\/\//, "")}</span></> : ""}
                {ws.salesforceInstalledAt && (
                  <> since {formatDate(ws.salesforceInstalledAt)}</>
                )}.{" "}
                {crmStats["salesforce"] ? <>{crmStats["salesforce"].count} accounts synced{fmtSync(crmStats["salesforce"].lastSync) ? <> · last {fmtSync(crmStats["salesforce"].lastSync)}</> : null}.</> : "Run a sync to pull accounts."}
              </p>
              <p className="text-xs muted note">
                {salesforceArrField
                  ? <>Accounts sync by name, with ARR from the <span className="mono">{salesforceArrField}</span> field. Manually set ARR is never overwritten.</>
                  : <>Accounts sync by name. To sync ARR too, an admin picks the field that holds what each account pays you (Annual Revenue is the account&apos;s own revenue, so it&apos;s never assumed).</>}
              </p>
              <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
                <SyncCrmButton provider="salesforce" />
                {isAdmin && integrationsEntitled && <CrmArrFieldPicker provider="salesforce" current={salesforceArrField} />}
                {isAdmin
                  ? <DisconnectSalesforceButton />
                  : <span className="text-xs muted">Only workspace admins can disconnect.</span>}
              </div>
            </>
          ) : (
            <>
              {notice("salesforce")}
              <p className="text-sm muted note">
                Sync your Salesforce accounts and their ARR into Accounts, so ranking by revenue uses live figures instead of hand-entered ones. Crumb only reads from Salesforce.
              </p>
              <ConnectNote name="Salesforce" provider="salesforce" canInstall={salesforceCanInstall} isAdmin={isAdmin} cloud={cloud} origin={origin} />
              <div className="row gap-2">
                {isAdmin && salesforceCanInstall && integrationsEntitled ? <ConnectSalesforceButton /> : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── Slack (your team's alerts, /crumb, @mention sizing) ─ */}
      <Card>
        <CardHead
          title="Slack"
          after={
            connectionPill(slackInstalled, slackCanInstall, !integrationsEntitled)
          }
        />
        <div className="card-body col gap-3">
          {slackBanner && <Banner kind={slackBanner.kind} text={slackBanner.text} />}

          {slackInstalled ? (
            <>
              <p className="text-sm note">
                Connected to <strong style={{ fontWeight: 500 }}>{ws.slackTeamName ?? "Slack"}</strong>
                {ws.slackInstalledAt && (
                  <> since {formatDate(ws.slackInstalledAt)}</>
                )}.
              </p>
              {integrationsEntitled ? (
                <p className="text-xs muted note">
                  Teammates who choose <em>Slack</em> in <a href="/settings/notifications" style={{ color: "var(--ink)" }}>their notification settings</a> get their alerts (customer replies, mentions, assignments, new feedback) as DMs instead of email. Crumb finds each teammate in Slack by their email address, and emails them when it can&apos;t. Teammates whose Slack email matches their Crumb account can type <span className="mono">/crumb</span> to capture feedback for a customer.
                </p>
              ) : (
                <PausedNote><span className="mono">/crumb</span> doesn&apos;t work and alerts go by email instead of Slack DMs</PausedNote>
              )}
              {isAdmin
                ? <DisconnectSlackButton teamName={ws.slackTeamName} />
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              {notice("slack")}
              <p className="text-sm muted note">
                Send your team&apos;s Crumb alerts as Slack DMs, to each teammate who chooses Slack in their notification settings. Capture feedback for a customer with <span className="mono">/crumb</span>, and on Cloud&apos;s Team and Growth plans, @mention Crumb on a message to size the request. Customers can get their own updates in Slack too: their account admin connects a channel from the widget.
              </p>
              <ConnectNote name="Slack" provider="slack" canInstall={slackCanInstall} isAdmin={isAdmin} cloud={cloud} origin={origin} />
              <div className="row gap-2">
                {isAdmin && slackCanInstall && integrationsEntitled
                  ? <ConnectSlackButton />
                  : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── MS Teams (channel notifications) ───────────────── */}
      <Card>
        <CardHead
          title="Microsoft Teams"
          after={teamsConnected ? <Pill ring ringFill>Connected</Pill> : <Pill>Not connected</Pill>}
        />
        <div className="card-body col gap-3">
          <p className="text-sm muted note">
            Post new feedback, customer replies, and status changes to a Teams channel. In Teams, add a <strong style={{ fontWeight: 500 }}>Workflows</strong> → "When a Teams webhook request is received" flow and paste its URL here. No app install required.
          </p>
          {teamsConnected ? (
            <>
              <p className="text-sm" style={{ margin: 0 }}>
                Connected{ws.teamsConnectedAt && <> since {formatDate(ws.teamsConnectedAt)}</>}.
              </p>
              {isAdmin
                ? <TeamsConnectedActions />
                : <span className="text-xs muted">Only workspace admins can change this.</span>}
            </>
          ) : isAdmin ? (
            <ConnectTeamsForm />
          ) : (
            <span className="text-xs muted">Only workspace admins can connect Teams.</span>
          )}
        </div>
      </Card>

      {/* ─── Session record (Cloud) ────────────────────────── */}
      <Card>
        <CardHead
          title="Session record"
          after={
            sessionRecordEntitled
              ? (ws.sessionRecordEnabled ? <Pill ring ringFill>On</Pill> : <Pill>Off</Pill>)
              : <Pill variant="muted">{cloud ? "Growth plan" : "Cloud only"}</Pill>
          }
        />
        <div className="card-body col gap-3">
          <p className="text-sm muted note">
            When a customer opts in from the widget, their feedback arrives with a video-like replay of their session so you can see what they were doing, no more guessing what "the page broke" means.
          </p>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            <strong style={{ fontWeight: 500 }}>When:</strong> while this is on, the widget keeps the last 2 minutes of each identified visitor's session in their browser's memory, from page load. Nothing is sent or stored until they tick "Record my session"; then those minutes go along, so the replay shows what happened before they opened the form. Unticking stops it and drops what was in memory.{" "}
            <strong style={{ fontWeight: 500 }}>What's recorded:</strong> the page as the customer sees it, their clicks and scrolling, and each network request's method, URL, status and timing, with secret-looking query values (tokens, passwords, keys) redacted. Request and response bodies are left out unless your embed sets <span className="mono">data-record-network-bodies="true"</span>; then they're kept, with secret-looking form, query and JSON values redacted. Text typed into form fields, password and email fields included, is masked; rich-text editors and hidden inputs record as-is unless you mark them (below). Sessions cap at 10 MB / 5,000 events / 30 minutes and {replayRetentionDays > 0 ? `are deleted after ${replayRetentionDays} days by the cleanup job` : "are kept indefinitely"}.
          </p>
          {sessionRecordEntitled ? (
            <div className="row gap-3 center">
              <SessionRecordToggle enabled={ws.sessionRecordEnabled} disabled={!isAdmin} />
              <span className="text-sm">
                {ws.sessionRecordEnabled
                  ? "On. Customers can send a recording of their session with their feedback."
                  : "Off. The widget doesn't load the recorder."}
              </span>
            </div>
          ) : cloud ? (
            <UpgradeNotice feature="session_record" isAdmin={isAdmin} />
          ) : (
            <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
              Session record is available on Crumb Cloud&apos;s Growth plan. Self-hosted Crumb doesn&apos;t include it.
            </p>
          )}
          {!isAdmin && sessionRecordEntitled && (
            <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can change this setting.</p>
          )}
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            <strong style={{ fontWeight: 500 }}>Heads up:</strong> if your site uses a strict Content-Security-Policy (<span className="mono">script-src 'self'</span>), the recorder bundle won't load. Allow this dashboard's origin in <span className="mono">script-src</span>. To opt out specific UI from recording, add <span className="mono">class="crumb-block"</span> (skip the whole subtree) or <span className="mono">class="crumb-mask"</span> (mask text).
          </p>
        </div>
      </Card>

      {/* ─── Inbound feedback connectors (Autopilot) ─────────── */}
      {(integrationsEntitled || feedbackConnections.length > 0) && (
        <FeedbackConnectors
          connections={feedbackConnections}
          canManage={isAdmin}
          aiEnabled={aiEnabled}
          paused={!integrationsEntitled}
        />
      )}
    </>
  );
}
