import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { fetchInstallationMeta, listInstallationRepos, verifyGithubState } from "@/lib/integrations/github";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GitHub App callback. Triggered after the admin completes the install on
// GitHub. Unlike OAuth, there's no code exchange — installation_id IS the
// credential. We persist it + the account login.

function redirectBack(req: Request, slug: string): Response {
  const url = new URL(req.url);
  url.pathname = "/settings/integrations";
  url.search = `?github=${slug}`;
  return NextResponse.redirect(url);
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
  if (!installationId || !state) return redirectBack(req, "error_missing_params");

  const v = verifyGithubState(state);
  if (!v.ok) return redirectBack(req, "error_bad_state");

  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, v.workspaceId))
    .limit(1);
  if (!ws) return redirectBack(req, "error_workspace_gone");

  let meta;
  try {
    meta = await fetchInstallationMeta(installationId);
  } catch (err) {
    log.error("github fetchInstallationMeta failed", { scope: "crumb/github", err });
    return redirectBack(req, "error_meta_failed");
  }

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
