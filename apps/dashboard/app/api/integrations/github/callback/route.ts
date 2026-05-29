import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { fetchInstallationMeta, verifyGithubState } from "@/lib/integrations/github";

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
    // eslint-disable-next-line no-console
    console.error("[crumb/github] fetchInstallationMeta failed:", err);
    return redirectBack(req, "error_meta_failed");
  }

  await db
    .update(workspaces)
    .set({
      githubAppInstallId:      installationId,
      githubAppInstallAccount: meta.account.login,
      githubInstalledAt:       new Date(),
    })
    .where(eq(workspaces.id, ws.id));

  return redirectBack(req, "connected");
}
