import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import {
  fetchInstallationMeta, listInstallationRepos, userAuthorizeUrl, verifyInstallOwnership, GITHUB_REDIRECT_URL,
} from "@/lib/integrations/github";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
import { callbackUrlFromRequest } from "@/lib/integrations/callback-url";
import { withoutAlert } from "@/lib/integrations/revoke";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GitHub App callback. Triggered after the admin completes the install on
// GitHub. installation_id arrives as a plain query parameter, so before it is
// persisted (with the account login) it must not belong to another workspace
// and the person finishing the install must own it (verifyInstallOwnership).

function redirectBack(req: Request, slug: string): Response {
  return redirectToSettings(req, "github", slug);
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Surfaces an error if the admin canceled on GitHub's side.
  const setupAction = url.searchParams.get("setup_action");
  if (setupAction && setupAction !== "install" && setupAction !== "update") {
    return redirectBack(req, `error_${encodeURIComponent(setupAction)}`);
  }

  const state = url.searchParams.get("state");
  if (!state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "github", state);
  if (!v.ok) return v.redirect;

  // Back from GitHub's user authorization (below), which returns only code +
  // state, the installation id is the one signed into the state.
  const installationId = v.data ?? url.searchParams.get("installation_id");
  // Canonical digits only (no leading zeros): the id is interpolated into
  // App-JWT API paths and string-compared with the stored install id below.
  if (!installationId || !/^[1-9]\d*$/.test(installationId)) return redirectBack(req, "error_missing_params");
  const code = url.searchParams.get("code");

  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, v.workspaceId))
    .limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  // An installation is never re-pointed away from the workspace holding it.
  const [taken] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.githubAppInstallId, installationId), ne(workspaces.id, ws.id)))
    .limit(1);
  if (taken) return redirectBack(req, "error_install_taken");

  // With the App's OAuth credentials set, ownership needs a code. GitHub adds
  // one only to a fresh install with user authorization on; reconnecting an
  // App that is already installed (setup_action=update, or none) comes back
  // without one. So send the installer through GitHub's user authorization,
  // once: on the way back the state carries the id, and no code fails closed.
  if (!code && !v.data) {
    const authorize = userAuthorizeUrl(ws.id, installationId, callbackUrlFromRequest("github", GITHUB_REDIRECT_URL(), req));
    if (authorize) return NextResponse.redirect(authorize);
  }

  let meta;
  try {
    meta = await fetchInstallationMeta(installationId);
  } catch (err) {
    log.error("github fetchInstallationMeta failed", { scope: "crumb/github", err });
    return redirectBack(req, "error_meta_failed");
  }

  const owned = await verifyInstallOwnership(installationId, meta, { code, setupAction });
  if (!owned) return redirectBack(req, "error_not_owner");

  // Convenience: if the install grants access to exactly one repo, pre-select
  // it as the default so the admin can create issues immediately. Best-effort.
  let defaultRepo: string | null = null;
  try {
    const repos = await listInstallationRepos(installationId);
    if (repos.length === 1) defaultRepo = repos[0].fullName;
  } catch (err) {
    log.warn("github repo pre-select failed (non-fatal)", { scope: "crumb/github", err });
  }

  await db
    .update(workspaces)
    .set({
      githubAppInstallId:      installationId,
      githubAppInstallAccount: meta.account.login,
      githubDefaultRepo:       defaultRepo,
      githubInstalledAt:       new Date(),
      integrationAlerts:       withoutAlert("github"),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
