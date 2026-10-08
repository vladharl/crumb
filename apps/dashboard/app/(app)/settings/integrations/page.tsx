import { headers } from "next/headers";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { SelfHostSetup } from "./SelfHostSetup";
import { originFromHeaders } from "@/lib/origin";
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

// Every callback's session check (lib/integrations/callback.ts).
const SESSION_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  error_wrong_workspace: { kind: "err", text: "You're signed in to a different workspace than the one that started this connection. Switch workspaces and connect again." },
  error_forbidden:       { kind: "err", text: "Only workspace admins can finish connecting an integration." },
};

const SLACK_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  ...SESSION_BANNER,
  connected:                  { kind: "ok",  text: "Slack connected. Members can now choose Slack delivery in their notification preferences." },
  error_missing_params:       { kind: "err", text: "Slack didn't include a valid response. Please try again." },
  error_bad_state:            { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:       { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed:      { kind: "err", text: "Slack rejected the token exchange. Check your app's client secret + scopes." },
  error_team_already_connected: { kind: "err", text: "That Slack workspace is already connected to another Crumb workspace. Disconnect it there first." },
};

const LINEAR_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  ...SESSION_BANNER,
  connected:             { kind: "ok",  text: "Linear connected. From any thread, click Create ticket in the Engineering panel to push the item out." },
  error_missing_params:  { kind: "err", text: "Linear didn't include a valid response. Please try again." },
  error_bad_state:       { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:  { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed: { kind: "err", text: "Linear rejected the token exchange. Check your OAuth app's client secret + redirect URL." },
};

const JIRA_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  ...SESSION_BANNER,
  connected:               { kind: "ok",  text: "Jira connected. From any thread, click Create ticket in the Engineering panel to push the item out." },
  connected_no_sync:       { kind: "ok",  text: "Jira connected, but status sync couldn't be set up. Reconnect to retry; ticket creation works." },
  pick_site:               { kind: "ok",  text: "Jira connected. Your Atlassian login reaches more than one Jira site, so choose the one this workspace uses below." },
  error_missing_params:    { kind: "err", text: "Jira didn't include a valid response. Please try again." },
  error_bad_state:         { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:    { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed:   { kind: "err", text: "Atlassian rejected the token exchange. Check your OAuth app's client secret + redirect URL." },
  error_resources_failed:  { kind: "err", text: "Couldn't discover your Atlassian site after install. Check that the app has access to at least one Jira site." },
  error_no_resources:      { kind: "err", text: "No Jira sites accessible with this user's credentials." },
};

const GITHUB_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  ...SESSION_BANNER,
  connected:           { kind: "ok",  text: "GitHub connected. Create tickets from any thread; the AI draft also pulls README + repo structure for any provider's drafts." },
  error_missing_params:{ kind: "err", text: "GitHub didn't include a valid response. Please try again." },
  error_bad_state:     { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:{ kind: "err", text: "Workspace not found while finishing the install." },
  error_meta_failed:   { kind: "err", text: "Couldn't fetch the App installation metadata. Check that the App's private key is configured." },
  error_install_taken: { kind: "err", text: "That GitHub installation is already connected to another Crumb workspace." },
  error_not_owner:     { kind: "err", text: "GitHub couldn't confirm you can access that installation. Start again from this page; if the App was installed earlier, reinstall it, or set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET with user authorization during installation turned on." },
};

const CRM_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  ...SESSION_BANNER,
  connected:             { kind: "ok",  text: "CRM connected. Accounts are syncing to the Accounts page. ARR syncs from the field chosen below, and manually set ARR is never overwritten." },
  error_missing_params:  { kind: "err", text: "The CRM didn't include a valid response. Please try again." },
  error_bad_state:       { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:  { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed: { kind: "err", text: "The CRM rejected the token exchange. Check your app's client secret + redirect URL." },
};

function Banner({ kind, text }: { kind: "ok" | "err"; text: string }) {
  return (
    <div className="text-sm" style={{
      background: kind === "ok" ? "var(--ok-bg, var(--surface-2))" : "var(--err-bg)",
      border: `1px solid ${kind === "ok" ? "var(--ok-border, var(--line))" : "var(--err-border)"}`,
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
  const slackBanner = searchParams.slack
    ? (SLACK_BANNER[searchParams.slack] ?? { kind: "err" as const, text: searchParams.slack.replace(/^error_/, "") })
    : null;

  const linearInstalled = !!ws.linearAccessToken;
  const linearCanInstall = linearConfigured();
  const linearBanner = searchParams.linear
    ? (LINEAR_BANNER[searchParams.linear] ?? { kind: "err" as const, text: searchParams.linear.replace(/^error_/, "") })
    : null;

  const jiraInstalled = !!ws.jiraAccessToken;
  const jiraCanInstall = jiraConfigured();
  const jiraStatusSync = jiraStatusSyncReady(ws);
  const jiraBanner = searchParams.jira
    ? (JIRA_BANNER[searchParams.jira] ?? { kind: "err" as const, text: searchParams.jira.replace(/^error_/, "") })
    : null;

  const githubInstalled = !!ws.githubAppInstallId;
  const githubCanInstall = githubConfigured();
  const githubBanner = searchParams.github
    ? (GITHUB_BANNER[searchParams.github] ?? { kind: "err" as const, text: searchParams.github.replace(/^error_/, "") })
    : null;

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
  const fmtSync = (d: Date | null | undefined) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

  const hubspotInstalled = !!ws.hubspotAccessToken;
  const hubspotCanInstall = crmConfigured("hubspot");
  const hubspotArrField = getCrmAdapter("hubspot").arrField(ws);
  const hubspotBanner = searchParams.hubspot
    ? (CRM_BANNER[searchParams.hubspot] ?? { kind: "err" as const, text: searchParams.hubspot.replace(/^error_/, "") })
    : null;

  const salesforceInstalled = !!ws.salesforceAccessToken;
  const salesforceCanInstall = crmConfigured("salesforce");
  const salesforceArrField = getCrmAdapter("salesforce").arrField(ws);
  const salesforceBanner = searchParams.salesforce
    ? (CRM_BANNER[searchParams.salesforce] ?? { kind: "err" as const, text: searchParams.salesforce.replace(/^error_/, "") })
    : null;

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
            linearInstalled
              ? <Pill ring ringFill>Connected</Pill>
              : !linearCanInstall
                ? <Pill ring ringFill>{cloud ? "Cloud" : "Set LINEAR_CLIENT_ID"}</Pill>
                : <Pill>Not connected</Pill>
          }
        />
        <div className="card-body col gap-3">
          {linearBanner && <Banner kind={linearBanner.kind} text={linearBanner.text} />}

          {linearInstalled ? (
            <>
              <p className="text-sm note">
                Connected to <strong style={{ fontWeight: 500 }}>{ws.linearTeamName ?? "Linear"}</strong>
                {ws.linearInstalledAt && (
                  <> since {ws.linearInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}.
              </p>
              <p className="text-xs muted note">
                Crumb status stays canonical. Engineering status from Linear writes to a separate field on the item, displayed in the thread sidebar, never authoritative.
              </p>
              {/* Cloud's Linear app carries the webhook; self-host adds its own. */}
              {!cloud && (
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
                Push Crumb items out as Linear issues, with status synced back via webhook. On Cloud, an AI draft suggests a title + body that matches your team's voice.
              </p>
              {!linearCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Linear isn't configured on this deployment yet."
                    : <>Self-host needs a registered Linear OAuth app: set <span className="mono">LINEAR_CLIENT_ID</span> and <span className="mono">LINEAR_CLIENT_SECRET</span>, then restart.</>}
                </p>
              )}
              {!linearCanInstall && !cloud && <SelfHostSetup provider="linear" origin={origin} />}
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
            jiraInstalled
              ? <Pill ring ringFill>Connected</Pill>
              : !jiraCanInstall
                ? <Pill ring ringFill>{cloud ? "Cloud" : "Set JIRA_CLIENT_ID"}</Pill>
                : <Pill>Not connected</Pill>
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
                  <> since {ws.jiraInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}
                {ws.jiraDefaultProjectKey && (
                  <> · default project <span className="mono">{ws.jiraDefaultProjectKey}</span></>
                )}.
              </p>
              <p className="text-xs muted note">
                Crumb status stays canonical. Engineering status from Jira writes to a separate field on the item, displayed in the thread sidebar, never authoritative.
              </p>
              {cloud && !jiraStatusSync && (
                <p className="text-xs note" style={{ color: "var(--err-text)" }}>
                  Status sync isn&apos;t set up, so linked tickets won&apos;t update here. Reconnect Jira to try again; creating tickets still works.
                </p>
              )}
              {!cloud && (
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
                Push Crumb items out as Jira issues, with status synced back via webhook. Atlassian Cloud only.
              </p>
              {!jiraCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Jira isn't configured on this deployment yet."
                    : <>Self-host needs a registered Atlassian 3LO OAuth app: set <span className="mono">JIRA_CLIENT_ID</span> and <span className="mono">JIRA_CLIENT_SECRET</span>, then restart.</>}
                </p>
              )}
              {!jiraCanInstall && !cloud && <SelfHostSetup provider="jira" origin={origin} />}
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
            githubInstalled
              ? <Pill ring ringFill>Connected</Pill>
              : !githubCanInstall
                ? <Pill ring ringFill>{cloud ? "Cloud" : "Set GITHUB_APP_*"}</Pill>
                : <Pill>Not connected</Pill>
          }
        />
        <div className="card-body col gap-3">
          {githubBanner && <Banner kind={githubBanner.kind} text={githubBanner.text} />}

          {githubInstalled ? (
            <>
              <p className="text-sm note">
                Installed on <strong style={{ fontWeight: 500 }}>{ws.githubAppInstallAccount ?? "GitHub"}</strong>
                {ws.githubInstalledAt && (
                  <> since {ws.githubInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}
                {ws.githubDefaultRepo && (
                  <> · default repo <span className="mono">{ws.githubDefaultRepo}</span></>
                )}.
              </p>
              <p className="text-xs muted note">
                {ws.githubDefaultRepo
                  ? "When AI drafting is enabled (Cloud + ANTHROPIC_API_KEY), README + repo structure also feed Linear/Jira drafts, not just GitHub."
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
                Push Crumb items out as GitHub issues. Status syncs back via webhook. When installed, README + repo structure also enrich AI drafts for any provider.
              </p>
              {!githubCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "GitHub App isn't configured on this deployment yet."
                    : <>Self-host needs a registered GitHub App: set <span className="mono">GITHUB_APP_ID</span>, <span className="mono">GITHUB_APP_PRIVATE_KEY</span>, and <span className="mono">GITHUB_APP_SLUG</span>, then restart.</>}
                </p>
              )}
              {!githubCanInstall && !cloud && <SelfHostSetup provider="github" origin={origin} />}
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
            hubspotInstalled
              ? <Pill ring ringFill>Connected</Pill>
              : !hubspotCanInstall
                ? <Pill ring ringFill>{cloud ? "Cloud" : "Set HUBSPOT_CLIENT_ID"}</Pill>
                : <Pill>Not connected</Pill>
          }
        />
        <div className="card-body col gap-3">
          {hubspotBanner && <Banner kind={hubspotBanner.kind} text={hubspotBanner.text} />}

          {hubspotInstalled ? (
            <>
              <p className="text-sm note">
                Connected{ws.hubspotPortalId ? <> to portal <span className="mono">{ws.hubspotPortalId}</span></> : ""}
                {ws.hubspotInstalledAt && (
                  <> since {ws.hubspotInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
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
                One-way sync of companies + ARR from HubSpot, so prioritization by revenue uses live dollar figures instead of hand-entered ones.
              </p>
              {!hubspotCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "HubSpot isn't configured on this deployment yet."
                    : <>Self-host needs a registered HubSpot app: set <span className="mono">HUBSPOT_CLIENT_ID</span> and <span className="mono">HUBSPOT_CLIENT_SECRET</span>, then restart.</>}
                </p>
              )}
              {!hubspotCanInstall && !cloud && <SelfHostSetup provider="hubspot" origin={origin} />}
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
            salesforceInstalled
              ? <Pill ring ringFill>Connected</Pill>
              : !salesforceCanInstall
                ? <Pill ring ringFill>{cloud ? "Cloud" : "Set SALESFORCE_CLIENT_ID"}</Pill>
                : <Pill>Not connected</Pill>
          }
        />
        <div className="card-body col gap-3">
          {salesforceBanner && <Banner kind={salesforceBanner.kind} text={salesforceBanner.text} />}

          {salesforceInstalled ? (
            <>
              <p className="text-sm note">
                Connected{ws.salesforceInstanceUrl ? <> to <span className="mono">{ws.salesforceInstanceUrl.replace(/^https?:\/\//, "")}</span></> : ""}
                {ws.salesforceInstalledAt && (
                  <> since {ws.salesforceInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
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
                One-way sync of Accounts + ARR from Salesforce. Sandboxes are supported via <span className="mono">SALESFORCE_LOGIN_URL</span>.
              </p>
              {!salesforceCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Salesforce isn't configured on this deployment yet."
                    : <>Self-host needs a Salesforce Connected App: set <span className="mono">SALESFORCE_CLIENT_ID</span> and <span className="mono">SALESFORCE_CLIENT_SECRET</span>, then restart.</>}
                </p>
              )}
              {!salesforceCanInstall && !cloud && <SelfHostSetup provider="salesforce" origin={origin} />}
              <div className="row gap-2">
                {isAdmin && salesforceCanInstall && integrationsEntitled ? <ConnectSalesforceButton /> : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── Slack (vendor notifications) ──────────────────── */}
      <Card>
        <CardHead
          title="Vendor-side Slack"
          after={
            slackInstalled
              ? <Pill ring ringFill>Connected</Pill>
              : !slackCanInstall
                ? <Pill ring ringFill>{cloud ? "Cloud" : "Set SLACK_CLIENT_ID"}</Pill>
                : <Pill>Not connected</Pill>
          }
        />
        <div className="card-body col gap-3">
          {slackBanner && <Banner kind={slackBanner.kind} text={slackBanner.text} />}

          {slackInstalled ? (
            <>
              <p className="text-sm note">
                Connected to <strong style={{ fontWeight: 500 }}>{ws.slackTeamName ?? "Slack"}</strong>
                {ws.slackInstalledAt && (
                  <> since {ws.slackInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}.
              </p>
              <p className="text-xs muted note">
                Members who pick <em>Slack</em> as their delivery channel on <a href="/settings/notifications" style={{ color: "var(--ink)" }}>their preferences</a> get DMs instead of email for customer replies. We look each member up by email the first time we DM them; failures fall back to email.
              </p>
              {isAdmin
                ? <DisconnectSlackButton teamName={ws.slackTeamName} />
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              {notice("slack")}
              <p className="text-sm muted note">
                Post new submissions, status changes, and replies into your team's Slack. Customer-side Slack is configured separately by each customer admin from inside the widget.
              </p>
              {!slackCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Slack isn't configured on this deployment yet."
                    : <>Self-host needs a registered Slack app: set <span className="mono">SLACK_CLIENT_ID</span> and <span className="mono">SLACK_CLIENT_SECRET</span>, then restart.</>}
                </p>
              )}
              {!slackCanInstall && !cloud && <SelfHostSetup provider="slack" origin={origin} />}
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
            Post new submissions, customer replies, and status changes to a Teams channel. In Teams, add a <strong style={{ fontWeight: 500 }}>Workflows</strong> → "When a Teams webhook request is received" flow and paste its URL here. No app install required.
          </p>
          {teamsConnected ? (
            <>
              <p className="text-sm" style={{ margin: 0 }}>
                Connected{ws.teamsConnectedAt && <> since {ws.teamsConnectedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>}.
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
              : <Pill ring ringFill>{cloud ? "Growth plan" : "Cloud"}</Pill>
          }
        />
        <div className="card-body col gap-3">
          <p className="text-sm muted note">
            When a customer opts in from the widget, their feedback arrives with a video-like replay of their session so you can see what they were doing, no more guessing what "the page broke" means.
          </p>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            <strong style={{ fontWeight: 500 }}>When:</strong> while this is on, the widget keeps the last 2 minutes of each identified visitor's session in their browser's memory, from page load. Nothing is sent or stored until they tick "Record my session"; then those minutes go along, so the replay shows what happened before they opened the form. Unticking stops it and drops what was in memory.{" "}
            <strong style={{ fontWeight: 500 }}>What's recorded:</strong> the page as the customer sees it, their clicks and scrolling, and each network request's method, URL, status and timing, with secret-looking query values (tokens, passwords, keys) redacted. Request and response bodies are left out unless your embed sets <span className="mono">data-record-network-bodies="true"</span>; then they're kept, with secret-looking form, query and JSON values redacted. Text typed into form fields is masked and password and email fields are never recorded; rich-text editors and hidden inputs record as-is unless you mark them (below). Sessions cap at 10 MB / 5,000 events / 30 minutes and {replayRetentionDays > 0 ? `are deleted after ${replayRetentionDays} days by the cleanup job` : "are kept indefinitely"}.
          </p>
          {sessionRecordEntitled ? (
            <div className="row gap-3 center">
              <SessionRecordToggle enabled={ws.sessionRecordEnabled} disabled={!isAdmin} />
              <span className="text-sm">
                {ws.sessionRecordEnabled
                  ? "Capturing new sessions across your installed widget."
                  : "Off. Widget skips loading the recorder bundle."}
              </span>
            </div>
          ) : cloud ? (
            <UpgradeNotice feature="session_record" isAdmin={isAdmin} />
          ) : (
            <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
              Session record is available on Crumb Cloud. Self-host can wire it manually by setting a non-local <span className="mono">CRUMB_STORAGE_PROVIDER</span>; the cleanup cron deletes replays after <span className="mono">CRUMB_REPLAY_RETENTION_DAYS</span> (default 30).
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
