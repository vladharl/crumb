import { BrandMark } from "@crumb/ui";
import { safeNextPath } from "@/lib/auth";
import { ContinueForm } from "../LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

// Where an emailed sign-in or invite link lands (GET /login/verify forwards
// here). Opening it signs no one in, so a mail scanner fetching the link can't
// burn it; the button POSTs the token back to /login/verify, which does.
export default function ContinuePage({ searchParams }: { searchParams: { token?: string; next?: string } }) {
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
            <h1 className="display" style={{ fontSize: 20, lineHeight: 1.2, margin: 0 }}>You're almost in</h1>
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.5 }}>
              Continue to finish signing in on this device.
            </p>
          </div>

          <ContinueForm token={searchParams.token ?? ""} next={safeNextPath(searchParams.next)} />
        </div>
      </div>
    </main>
  );
}
