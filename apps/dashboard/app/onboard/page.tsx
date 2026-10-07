import { redirect } from "next/navigation";
import { db, workspaces, findValidSetupToken } from "@crumb/db";
import { BrandMark } from "@crumb/ui";
import { OnboardForm } from "./OnboardForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up" };

export default async function OnboardPage({ searchParams }: { searchParams: { token?: string } }) {
  // Onboarding creates a NEW workspace (+ its first admin). The one-time setup
  // link minted on the host (`cli setup-link`, or printed to the container logs
  // on a fresh instance) is the only gate — it works for the first use of ANY
  // workspace, not just the first one on the instance.
  const token = searchParams.token ?? "";
  const setup = token ? await findValidSetupToken(token) : null;

  // No valid link: an instance that's set up sends people to sign in; a fresh
  // one says where the link is instead of dead-ending at invite-only sign-in.
  if (!setup) {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    if (ws) redirect("/login");
  }

  return (
    <main style={{
      background: "var(--cream)",
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 16,
    }}>
      <div className="card" style={{ width: 440, maxWidth: "calc(100vw - 32px)", padding: 28 }}>
        <div className="col gap-4">
          <div className="row gap-3 center">
            <BrandMark width={36} height={36} />
            <div className="col">
              <span className="serif" style={{ fontSize: 22, lineHeight: 1.05 }}>Welcome to Crumb</span>
              <span className="text-xs muted">Set up your workspace.</span>
            </div>
          </div>

          <hr className="divider" />

          {setup ? (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
                Create a new workspace. You'll be its admin, and you can add teammates after.
              </p>

              <OnboardForm token={token} />
            </>
          ) : (
            <>
              <div className="col gap-1">
                <h1 className="display" style={{ fontSize: 20, lineHeight: 1.2, margin: 0 }}>Open your setup link</h1>
                <p className="note text-sm muted">
                  There's no workspace here yet. To create one, open the one-time setup link from your server, so nobody else can claim this install.
                </p>
              </div>

              {token && (
                <div className="text-sm" style={{
                  background: "var(--err-bg)",
                  border: "1px solid var(--err-border)",
                  color: "var(--err-text)",
                  borderRadius: "var(--r-sm)",
                  padding: "10px 12px",
                }}>That setup link has expired or is incomplete. Get a fresh one below.</div>
              )}

              <div className="col gap-2">
                <p className="note text-sm">Find it in the dashboard's logs:</p>
                <div className="code" style={{ whiteSpace: "pre-wrap" }}>docker compose logs dashboard</div>
              </div>

              <div className="col gap-2">
                <p className="note text-sm">Or make a fresh one:</p>
                <div className="code" style={{ whiteSpace: "pre-wrap" }}>docker compose exec dashboard node packages/db/dist/cli.mjs setup-link</div>
              </div>

              <p className="note text-xs muted">Each link works once and expires after 60 minutes.</p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
