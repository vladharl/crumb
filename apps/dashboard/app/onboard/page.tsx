import { redirect } from "next/navigation";
import { findValidSetupToken } from "@crumb/db";
import { BrandMark } from "@crumb/ui";
import { OnboardForm } from "./OnboardForm";

export const dynamic = "force-dynamic";

export default async function OnboardPage({ searchParams }: { searchParams: { token?: string } }) {
  // Onboarding creates a NEW workspace (+ its first admin). The one-time setup
  // link minted on the host (`cli setup-link`) is the only gate — it works for
  // the first use of ANY workspace, not just the first one on the instance.
  // No valid token bounces to the sign-in screen.
  const token = searchParams.token ?? "";
  const setup = token ? await findValidSetupToken(token) : null;
  if (!setup) redirect("/login");

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

          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Create a new workspace. You'll be its admin — add teammates after.
          </p>

          <OnboardForm token={token} />
        </div>
      </div>
    </main>
  );
}
