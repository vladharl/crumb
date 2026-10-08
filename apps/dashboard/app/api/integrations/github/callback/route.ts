import { and, eq, ne } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { fetchInstallationMeta, listInstallationRepos, verifyInstallOwnership } from "@/lib/integrations/github";
import { redirectToSettings, verifyCallback } from "@/lib/integrations/callback";
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

  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");
  // Canonical digits only (no leading zeros): the id is interpolated into
  // App-JWT API paths and string-compared with the stored install id below.
  if (!installationId || !/^[1-9]\d*$/.test(installationId) || !state) return redirectBack(req, "error_missing_params");

  const v = await verifyCallback(req, "github", state);
  if (!v.ok) return v.redirect;

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

  let meta;
  try {
    meta = await fetchInstallationMeta(installationId);
  } catch (err) {
    log.error("github fetchInstallationMeta failed", { scope: "crumb/github", err });
    return redirectBack(req, "error_meta_failed");
  }

  const owned = await verifyInstallOwnership(installationId, meta, {
    code: url.searchParams.get("code"),
    setupAction,
  });
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
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
