import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { slackConfigured } from "@/lib/slack/install";
import { linearConfigured } from "@/lib/integrations/linear";
import { jiraConfigured } from "@/lib/integrations/jira";
import { githubConfigured } from "@/lib/integrations/github";
import { ConnectSlackButton, DisconnectSlackButton } from "./SlackActions";
import { ConnectLinearButton, DisconnectLinearButton } from "./LinearActions";
import { ConnectJiraButton, DisconnectJiraButton } from "./JiraActions";
import { ConnectGithubButton, DisconnectGithubButton } from "./GithubActions";
import { SessionRecordToggle } from "./SessionRecordToggle";

export const dynamic = "force-dynamic";

const SLACK_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  connected:                  { kind: "ok",  text: "Slack connected. Members can now choose Slack delivery in their notification preferences." },
  error_missing_params:       { kind: "err", text: "Slack didn't include a valid response. Please try again." },
  error_bad_state:            { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:       { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed:      { kind: "err", text: "Slack rejected the token exchange. Check your app's client secret + scopes." },
};

const LINEAR_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  connected:             { kind: "ok",  text: "Linear connected. From any thread, click Create ticket in the Engineering panel to push the item out." },
  error_missing_params:  { kind: "err", text: "Linear didn't include a valid response. Please try again." },
  error_bad_state:       { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:  { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed: { kind: "err", text: "Linear rejected the token exchange. Check your OAuth app's client secret + redirect URL." },
};

const JIRA_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  connected:               { kind: "ok",  text: "Jira connected. From any thread, click Create ticket in the Engineering panel to push the item out." },
  error_missing_params:    { kind: "err", text: "Jira didn't include a valid response. Please try again." },
  error_bad_state:         { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:    { kind: "err", text: "Workspace not found while finishing the install." },
  error_exchange_failed:   { kind: "err", text: "Atlassian rejected the token exchange. Check your OAuth app's client secret + redirect URL." },
  error_resources_failed:  { kind: "err", text: "Couldn't discover your Atlassian site after install. Check that the app has access to at least one Jira site." },
  error_no_resources:      { kind: "err", text: "No Jira sites accessible with this user's credentials." },
};

const GITHUB_BANNER: Record<string, { kind: "ok" | "err"; text: string }> = {
  connected:           { kind: "ok",  text: "GitHub connected. Create tickets from any thread; the AI draft also pulls README + repo structure for any provider's drafts." },
  error_missing_params:{ kind: "err", text: "GitHub didn't include a valid response. Please try again." },
  error_bad_state:     { kind: "err", text: "Install request couldn't be verified. Please start the connection from this page." },
  error_workspace_gone:{ kind: "err", text: "Workspace not found while finishing the install." },
  error_meta_failed:   { kind: "err", text: "Couldn't fetch the App installation metadata. Check that the App's private key is configured." },
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
  searchParams: { slack?: string; linear?: string; jira?: string; github?: string };
}) {
  const { workspace: ws, user } = await getActiveSession();
  const cloud = isCloud();
  const isAdmin = user.role === "admin";

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
  const jiraBanner = searchParams.jira
    ? (JIRA_BANNER[searchParams.jira] ?? { kind: "err" as const, text: searchParams.jira.replace(/^error_/, "") })
    : null;

  const githubInstalled = !!ws.githubAppInstallId;
  const githubCanInstall = githubConfigured();
  const githubBanner = searchParams.github
    ? (GITHUB_BANNER[searchParams.github] ?? { kind: "err" as const, text: searchParams.github.replace(/^error_/, "") })
    : null;

  return (
    <>
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
              <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Connected to <strong style={{ fontWeight: 500 }}>{ws.linearTeamName ?? "Linear"}</strong>
                {ws.linearInstalledAt && (
                  <> since {ws.linearInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}.
              </p>
              <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Crumb status stays canonical. Engineering status from Linear writes to a separate field on the item — displayed in the thread sidebar, never authoritative.
              </p>
              {isAdmin
                ? <DisconnectLinearButton teamName={ws.linearTeamName} />
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Push Crumb items out as Linear issues, with status synced back via webhook. On Cloud, an AI draft suggests a title + body that matches your team's voice.
              </p>
              {!linearCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Linear isn't configured on this deployment yet."
                    : <>Self-host needs a registered Linear OAuth app: set <span className="mono">LINEAR_CLIENT_ID</span> and <span className="mono">LINEAR_CLIENT_SECRET</span>, then restart. See the README.</>}
                </p>
              )}
              <div className="row gap-2">
                {isAdmin && linearCanInstall
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

          {jiraInstalled ? (
            <>
              <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Connected to <strong style={{ fontWeight: 500 }}>{ws.jiraSiteUrl ? ws.jiraSiteUrl.replace(/^https?:\/\//, "") : "Jira"}</strong>
                {ws.jiraInstalledAt && (
                  <> since {ws.jiraInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}
                {ws.jiraDefaultProjectKey && (
                  <> · default project <span className="mono">{ws.jiraDefaultProjectKey}</span></>
                )}.
              </p>
              <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Crumb status stays canonical. Engineering status from Jira writes to a separate field on the item — displayed in the thread sidebar, never authoritative.
              </p>
              {isAdmin
                ? <DisconnectJiraButton siteUrl={ws.jiraSiteUrl} />
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Push Crumb items out as Jira issues, with status synced back via webhook. Atlassian Cloud only.
              </p>
              {!jiraCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Jira isn't configured on this deployment yet."
                    : <>Self-host needs a registered Atlassian 3LO OAuth app: set <span className="mono">JIRA_CLIENT_ID</span> and <span className="mono">JIRA_CLIENT_SECRET</span>, then restart. See the README.</>}
                </p>
              )}
              <div className="row gap-2">
                {isAdmin && jiraCanInstall
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
              <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Installed on <strong style={{ fontWeight: 500 }}>{ws.githubAppInstallAccount ?? "GitHub"}</strong>
                {ws.githubInstalledAt && (
                  <> since {ws.githubInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}
                {ws.githubDefaultRepo && (
                  <> · default repo <span className="mono">{ws.githubDefaultRepo}</span></>
                )}.
              </p>
              <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                When AI drafting is enabled (Cloud + ANTHROPIC_API_KEY), README + repo structure also feed Linear/Jira drafts — not just GitHub.
              </p>
              {isAdmin
                ? <DisconnectGithubButton account={ws.githubAppInstallAccount} />
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Push Crumb items out as GitHub issues. Status syncs back via webhook. When installed, README + repo structure also enrich AI drafts for any provider.
              </p>
              {!githubCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "GitHub App isn't configured on this deployment yet."
                    : <>Self-host needs a registered GitHub App: set <span className="mono">GITHUB_APP_ID</span>, <span className="mono">GITHUB_APP_PRIVATE_KEY</span>, and <span className="mono">GITHUB_APP_SLUG</span>, then restart. See the README.</>}
                </p>
              )}
              <div className="row gap-2">
                {isAdmin && githubCanInstall
                  ? <ConnectGithubButton />
                  : null}
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
              <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Connected to <strong style={{ fontWeight: 500 }}>{ws.slackTeamName ?? "Slack"}</strong>
                {ws.slackInstalledAt && (
                  <> since {ws.slackInstalledAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</>
                )}.
              </p>
              <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Members who pick <em>Slack</em> as their delivery channel on <a href="/notifications" style={{ color: "var(--ink)" }}>their preferences</a> get DMs instead of email for customer replies. We look each member up by email the first time we DM them; failures fall back to email.
              </p>
              {isAdmin
                ? <DisconnectSlackButton teamName={ws.slackTeamName} />
                : <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can disconnect.</p>}
            </>
          ) : (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Post new submissions, status changes, and replies into your team's Slack. Customer-side Slack is configured separately by each customer admin from inside the widget.
              </p>
              {!slackCanInstall && (
                <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                  {cloud
                    ? "Slack isn't configured on this deployment yet."
                    : <>Self-host needs a registered Slack app: set <span className="mono">SLACK_CLIENT_ID</span> and <span className="mono">SLACK_CLIENT_SECRET</span>, then restart. See the README.</>}
                </p>
              )}
              <div className="row gap-2">
                {isAdmin && slackCanInstall
                  ? <ConnectSlackButton />
                  : null}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ─── Session record (Cloud) ────────────────────────── */}
      <Card>
        <CardHead
          title="Session record"
          after={
            cloud
              ? (ws.sessionRecordEnabled ? <Pill ring ringFill>On</Pill> : <Pill>Off</Pill>)
              : <Pill ring ringFill>Cloud</Pill>
          }
        />
        <div className="card-body col gap-3">
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
            When a customer submits feedback, attach a video-like replay of their session so you can see what they were doing — no more guessing what "the page broke" means. All inputs are masked by default; password and email fields are never recorded. Sessions cap at 10 MB / 5,000 events / 30 minutes.
          </p>
          {cloud ? (
            <div className="row gap-3 center">
              <SessionRecordToggle enabled={ws.sessionRecordEnabled} disabled={!isAdmin} />
              <span className="text-sm">
                {ws.sessionRecordEnabled
                  ? "Capturing new sessions across your installed widget."
                  : "Off — widget skips loading the recorder bundle."}
              </span>
            </div>
          ) : (
            <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
              Session record is available on Crumb Cloud. Self-host can wire it manually by setting a non-local <span className="mono">CRUMB_STORAGE_PROVIDER</span> and owning your own retention policy.
            </p>
          )}
          {!isAdmin && cloud && (
            <p className="text-xs muted" style={{ margin: 0 }}>Only workspace admins can change this setting.</p>
          )}
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            <strong style={{ fontWeight: 500 }}>Heads up:</strong> if your site uses a strict Content-Security-Policy (<span className="mono">script-src 'self'</span>), the recorder bundle won't load. Allow this dashboard's origin in <span className="mono">script-src</span>. To opt out specific UI from recording, add <span className="mono">class="crumb-block"</span> (skip the whole subtree) or <span className="mono">class="crumb-mask"</span> (mask text).
          </p>
        </div>
      </Card>
    </>
  );
}
