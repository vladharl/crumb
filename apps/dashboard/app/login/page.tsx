import { redirect } from "next/navigation";
import { db, workspaceUsers } from "@crumb/db";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./LoginForm";
import { BrandMark } from "@crumb/ui";

export const dynamic = "force-dynamic";

type SearchParams = {
  e?: string;
};

const ERROR_COPY: Record<string, string> = {
  expired: "That link has expired. Request a fresh one below.",
  consumed: "That link was already used. Request a new one if you need it.",
  not_found: "We couldn't find that link. Request a new one below.",
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (session) redirect("/inbox");

  // First-run: zero users on this instance → onboarding flow.
  const [anyUser] = await db.select({ id: workspaceUsers.id }).from(workspaceUsers).limit(1);
  if (!anyUser) redirect("/onboard");

  const errorCode = searchParams.e;
  const error = errorCode ? (ERROR_COPY[errorCode] ?? null) : null;

  return (
    <main style={{
      background: "var(--cream)",
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 16,
    }}>
      <div className="card" style={{ width: 380, maxWidth: "calc(100vw - 32px)", padding: 28 }}>
        <div className="col gap-4">
          <div className="row gap-3 center">
            <BrandMark width={36} height={36} />
            <div className="col">
              <span className="serif" style={{ fontSize: 22, lineHeight: 1.05 }}>Crumb</span>
              <span className="text-xs muted">Follow the trail.</span>
            </div>
          </div>

          <hr className="divider" />

          <div className="col gap-1">
            <h1 className="display" style={{ fontSize: 20, lineHeight: 1.2, margin: 0 }}>Sign in</h1>
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.5 }}>
              We'll email you a link. No password to remember.
            </p>
          </div>

          {error && (
            <div className="text-sm" style={{
              background: "var(--err-bg)",
              border: "1px solid var(--err-border)",
              color: "var(--err-text)",
              borderRadius: "var(--r-sm)",
              padding: "10px 12px",
            }}>{error}</div>
          )}

          <LoginForm />

          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Self-hosting? Run <span className="mono">pnpm db:seed</span> once to create the first team, then sign in as any of the seeded admins.
          </p>
        </div>
      </div>
    </main>
  );
}
